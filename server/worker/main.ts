import { jobs } from "../jobs";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { runtimeStore } from "../db/runtime";
import { OUTPUT_ROOT } from "../paths";
import { tick } from "../poster";
import { watcherTick } from "../watcher";
import { registerStudioWorkers } from "../studio/worker-adapters";
import { enqueueWork, workQueue } from "./api";
import { registerWork, stagesFor } from "./registry";
import { registerMediaWorkers } from "./media";
import { admitResources } from "./budget";
import { runJob } from "./runner";
const SERVICE_MS = 15_000;
const recovered = new Set<string>();
export function registerWorkers() {
  registerMediaWorkers();
  registerStudioWorkers();
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
export async function workerOnce(
  owner: string,
  signal: AbortSignal,
  options: { maintenance?: boolean } = {},
): Promise<boolean> {
  if (!takeService(owner)) return false;
  const q = workQueue();
  if (!recovered.has(owner)) {
    await jobs().recoverDurable();
    recovered.add(owner);
  }
  if (options.maintenance) {
    const bucket = Math.floor(Date.now() / 30_000);
    await enqueueWork({
      kind: "poster",
      workKey: "poster:tick",
      inputRevision: bucket,
      payload: {},
    }).catch(() => {});
    if (bucket % 2 === 0)
      await enqueueWork({
        kind: "watcher",
        workKey: "watcher:tick",
        inputRevision: bucket,
        payload: {},
      }).catch(() => {});
  }
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
    admit: async (job, stage) => admitResources(job, OUTPUT_ROOT, stage),
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
