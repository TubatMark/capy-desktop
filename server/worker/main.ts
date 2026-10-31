import { admissionReasons } from "../automation-policy";
import { jobs } from "../jobs";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { runtimeStore } from "../db/runtime";
import { OUTPUT_ROOT } from "../paths";
import { tick } from "../poster";
import { maybeAutoSchedule } from "../auto-schedule";
import { watcherTick } from "../watcher";
import { registerThumbnailWorkers } from "../thumbnails";
import { registerStudioWorkers } from "../studio/worker-adapters";
import {
  maybeSweepSimilarity,
  registerSimilarityWorkers,
} from "../similarity";
import { enqueueWork, workQueue } from "./api";
import { registerWork, stagesFor } from "./registry";
import { registerMediaWorkers } from "./media";
import { admitResources } from "./budget";
import { runJob } from "./runner";
import { pruneTicks, sweepScratch } from "./scratch";
import { maybeObserveLongForm, registerLongFormWorkers } from "../longform/queue";
const SERVICE_MS = 15_000;
const recovered = new Set<string>();
const serviceAt = new Map<string, number>();
let lastBucket = -1;
export function registerWorkers() {
  registerMediaWorkers();
  registerStudioWorkers();
  registerThumbnailWorkers();
  registerSimilarityWorkers();
  registerLongFormWorkers();
  registerWork("poster", () => [
    {
      name: "posting",
      timeoutMs: 30 * 60_000,
      run: async () => {
        await tick();
      },
    },
  ]);
  registerWork("watcher", (lease) => [
    {
      name: "watching",
      expensive: true,
      run: async () => {
        await watcherTick(undefined, { force: lease.payload.force === true });
      },
    },
  ]);
}
export function takeService(owner: string, now = Date.now()): boolean {
  const store = runtimeStore();
  return store.transaction(() => {
    const current = store.get<{ owner: string; expiresAt: number }>(
      "worker",
      "service",
    )?.value;
    if (current && current.owner !== owner && current.expiresAt > now)
      return false;
    store.put("worker", "service", {
      owner,
      heartbeat: now,
      expiresAt: now + SERVICE_MS,
    });
    return true;
  });
}
/** Routine upkeep. Runs on its own timer too, so a long job doesn't stop scheduling or cleanup. */
let maintaining = false;
async function maintain() {
  if (maintaining) return;
  maintaining = true;
  try {
    const q = workQueue();
    const bucket = Math.floor(Date.now() / 30_000);
    const fresh = bucket !== lastBucket;
    lastBucket = bucket;
    if (fresh) await enqueueWork({
      kind: "poster",
      workKey: "poster:tick",
      inputRevision: bucket,
      payload: {},
    }).catch(() => {});
    if (fresh && bucket % 2 === 0)
      await enqueueWork({
        kind: "watcher",
        workKey: "watcher:tick",
        inputRevision: bucket,
        payload: {},
      }).catch(() => {});
    // "Similar clips": a cheap pre-pass; AI work is queued only when a compared set changed
    await maybeSweepSimilarity();
    // clips that pass every check go to the schedule without waiting for approval (owner's setting)
    await maybeAutoSchedule();
    await maybeObserveLongForm().catch(() => {});
    try {
      sweepScratch(OUTPUT_ROOT, (id) => q.get(id)?.status);
      pruneTicks(runtimeStore().db);
    } catch (e) {
      console.error("[worker] scratch sweep failed", e);
    }
  } finally {
    maintaining = false;
  }
}
export async function workerOnce(
  owner: string,
  signal: AbortSignal,
  options: { maintenance?: boolean } = {},
): Promise<boolean> {
  // the beat in startWorker keeps the claim alive; committing it every loop is wasted disk writes
  if (Date.now() - serviceAt.get(owner)! < SERVICE_MS / 3) {
    /* still ours */
  } else if (!takeService(owner)) return false;
  else serviceAt.set(owner, Date.now());
  const q = workQueue();
  if (!recovered.has(owner)) {
    await jobs().recoverDurable();
    recovered.add(owner);
  }
  if (options.maintenance) await maintain();
  const lease = await q.claim(owner);
  if (!lease) return false;
  let stages;
  try {
    stages = stagesFor(lease);
  } catch (e) {
    q.finish(lease, "needs_action", (e as Error).message);
    return true;
  }
  await runJob(lease, signal, {
    queue: q,
    stages,
    artifactRoot: OUTPUT_ROOT,
    admit: async (job, stage) => [
      ...admissionReasons(job),
      ...(stage.expensive ? admitResources(job, OUTPUT_ROOT, stage) : []),
    ],
  });
  return true;
}
export async function startWorker(
  signal: AbortSignal,
  owner = randomUUID(),
): Promise<void> {
  registerWorkers();
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  let ac = new AbortController();
  const abort = () => ac.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) ac.abort();
  const beat = setInterval(() => {
    if (!takeService(owner)) ac.abort();
    else {
      serviceAt.set(owner, Date.now());
      void maintain().catch((e) => console.error("[worker] upkeep", e));
    }
  }, SERVICE_MS / 3);
  try {
    while (!signal.aborted) {
      if (ac.signal.aborted) ac = new AbortController();
      await workerOnce(owner, ac.signal, { maintenance: true });
      if (!signal.aborted)
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    clearInterval(beat);
    signal.removeEventListener("abort", abort);
    const store = runtimeStore();
    store.transaction(() => {
      const current = store.get<{ owner: string }>("worker", "service")?.value;
      if (current?.owner === owner)
        store.put("worker", "service", {
          ...current,
          expiresAt: 0,
          heartbeat: Date.now(),
        });
    });
  }
}
if (process.env.CAPY_WORKER === "1") {
  const ac = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => ac.abort());
  startWorker(ac.signal).catch((error) => {
    console.error("[worker]", error);
    process.exitCode = 1;
  });
}
