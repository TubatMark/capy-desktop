import { afterAll, beforeEach, expect, it, vi } from "vitest";
const env = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-final-integration-"));
  process.env.CAPY_OUTPUT = p.join(root, "output");
  process.env.CAPY_DATA_DIR = p.join(root, "data");
  process.env.CAPY_DISK_RESERVE_BYTES = "0";
  fs.mkdirSync(process.env.CAPY_OUTPUT, { recursive: true });
  return { root };
});
import path from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { runtimeStore } from "../server/db/runtime";
import { importLegacy } from "../server/db/import-legacy";
import { adoptLegacyAsset, listAssets, checksum, studioDependencies } from "../server/studio/assets";
import { createProject } from "../server/studio/projects";
import { registerStudioWorkers } from "../server/studio/worker-adapters";
import { stagesFor } from "../server/worker/registry";
import { WorkQueue } from "../server/worker/leases";
import { runJob } from "../server/worker/runner";
import { withWork } from "../server/worker/context";
import { run } from "../src/exec";
import { OUTPUT_ROOT } from "../server/paths";
import { prepareRenderReview, requestProjectRender } from "../server/studio/render";
import { decide, eligibility } from "../server/publication-policy";
import { queue, resetQueueCache } from "../server/queue";
import { createDelivery, updateDelivery, deliveryForPackage, readDeliveryHandles, saveDeliveryHandles } from "../server/delivery-store";
import { reconcileDelivery } from "../server/delivery";
import { publicationFixture } from "./publication-fixtures";
import type { AssetRef, RenderArtifact } from "../lib/studio/types";
let serial = 0;
beforeEach(() => { process.env.CAPY_DATA_DIR = path.join(env.root, `data-${++serial}`); resetQueueCache(); });
afterAll(async () => { await rm(env.root, { recursive: true, force: true }); });
async function media() {
  const file = path.join(OUTPUT_ROOT, `real-${serial}.mp4`);
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=160x90:r=30:d=1", "-c:v", "libx264", "-y", file]);
  return file;
}
async function runNext(q: WorkQueue) {
  const lease = await q.claim("integration");
  expect(lease).toBeTruthy();
  await runJob(lease!, new AbortController().signal, { queue: q, stages: stagesFor(lease!), artifactRoot: OUTPUT_ROOT });
  expect(q.get(lease!.id)?.status).toBe("complete");
}
it("legacy available and missing inventory adopts into actual probe, project Add and exported managed media", async () => {
  const file = await media(), bytes = await readFile(file), store = runtimeStore();
  const sourceDir = path.join(OUTPUT_ROOT, `legacy-${serial}`);
  await mkdir(sourceDir, { recursive: true });
  const job = {
    id: `legacy-${serial}`, videoId: "ABCDEFGHIJK", url: "https://youtube.com/watch?v=ABCDEFGHIJK", dir: `legacy-${serial}`,
    status: "ready", stage: "done", stageStartedAt: 0, createdAt: 0,
    settings: { count: 3, minSec: 20, maxSec: 60, layout: "center", style: "bold", captions: true, hook: true, maxRes: 1080 },
    estimate: { stageRemaining: 0, totalRemaining: 0, progress: 1 }, log: [],
    clips: [file, path.join(sourceDir, "missing.mp4")].map((file, n) => ({ n: n + 1, start: 0, end: 1, title: "Legacy", hook: "", reason: "original", score: 1, selected: true, render: { status: "done", file } })),
  };
  const jobFile = path.join(sourceDir, "job.json");
  await writeFile(jobFile, JSON.stringify(job));
  const oldApproval = {
    key: "old:1:youtube", jobId: job.id, n: 1, platform: "youtube" as const,
    status: "scheduled" as const, clipTitle: "Legacy approved clip", text: { title: "Old approved text" },
    attempts: 0, history: [{ t: 1, msg: "Historically approved" }], createdAt: 1, updatedAt: 1,
  };
  await mkdir(process.env.CAPY_DATA_DIR!, { recursive: true });
  const queueFile = path.join(process.env.CAPY_DATA_DIR!, "queue.json");
  await writeFile(queueFile, JSON.stringify([oldApproval]));
  await importLegacy({ dataDir: process.env.CAPY_DATA_DIR!, outputRoot: OUTPUT_ROOT, store });
  const originalRows = store.list("legacy-jobs");
  const originalQueue = store.get("legacy-state", "queue");
  const inventory = await listAssets();
  expect(inventory.map((a) => a.status).sort()).toEqual(["missing", "waiting"]);
  expect(inventory.every((a) => !a.checksum)).toBe(true);
  // Also cover the incomplete ready row written by an already-installed old migration.
  const available = inventory.find((a) => a.status === "waiting")!;
  store.put("assets", available.id, { ...available, status: "ready" });
  expect((await listAssets()).find((a) => a.id === available.id)?.status).toBe("waiting");
  registerStudioWorkers();
  const q = new WorkQueue(store), deps = { ...studioDependencies(), enqueue: (i: any) => q.enqueue(i) };
  const adopted = await adoptLegacyAsset(available.id, undefined, deps);
  const missing = inventory.find((a) => a.status === "missing")!;
  const recovered = await adoptLegacyAsset(missing.id, file, deps);
  expect(recovered.id).not.toBe(missing.id);
  expect(adopted.id).not.toBe(available.id);
  for (const a of [adopted, recovered]) {
    expect(a.checksum).toBe(await checksum(file));
    expect(a.location).toContain("/studio/assets/");
    expect(a.mediaUrl).toContain("/api/media/");
    await runNext(q);
    expect(store.get<AssetRef>("assets", a.id)?.value).toMatchObject({ status: "ready", durationUs: 1000000 });
  }
  const doc = await createProject({ sources: [{ assetId: adopted.id }, { assetId: recovered.id }] }, deps);
  expect(doc.items).toHaveLength(2);
  const work = await requestProjectRender(doc.id, doc.revision, { aspect: "portrait", fps: 30, codec: "h264-aac" }, deps);
  await runNext(q);
  const output = store.get<RenderArtifact>("renders", work.id)?.value ?? store.list<RenderArtifact>("renders")[0]?.value;
  expect(output).toBeTruthy();
  expect(output!.probe).toMatchObject({ width: 1080, height: 1920, durationUs: 2000000 });
  expect(await checksum(output!.path)).toBe(output!.checksum);
  expect((await readFile(output!.path)).length).toBeGreaterThan(1000);
  expect(await readFile(file)).toEqual(bytes);
  expect(await readFile(jobFile, "utf8")).toBe(JSON.stringify(job));
  expect(store.list("legacy-jobs")).toEqual(originalRows);
  expect(store.get("legacy-state", "queue")).toEqual(originalQueue);
  expect(await readFile(queueFile, "utf8")).toBe(JSON.stringify([oldApproval]));
  expect(eligibility(oldApproval).allowed).toBe(false);
  expect(store.list("publication-decisions")).toEqual([]);
  expect(store.list("deliveries")).toEqual([]);
}, 60000);

it.each(["needs_action", "scheduled", "failed"] as const)("Studio review cannot replace a %s remote intent and reconciliation retains handles", async (status) => {
  publicationFixture();
  const store = runtimeStore(), file = await media(), digest = await checksum(file);
  store.put("projects", "p", { id: "p", revision: 1, name: "Studio" });
  store.put("renders", "r", { id: "r", projectId: "p", revision: 1, checksum: digest, path: file });
  const draft = await prepareRenderReview("p", "r", digest, "youtube", { title: "Original" });
  const approved = { ...decide(draft, false, new Date()), status };
  queue().mutate(() => [approved]);
  const d = createDelivery({ ...approved, status: "scheduled" });
  saveDeliveryHandles(d, { session: "https://fixture/session", videoId: "remote" });
  updateDelivery(d.id, (v) => ({ ...v, phase: "transfer-intent", checkpoint: 1, state: "delivery-unknown" }));
  const original = store.get("legacy-state", "queue"), durable = deliveryForPackage(d.package.packageHash), handles = readDeliveryHandles(d);
  await expect(prepareRenderReview("p", "r", digest, "youtube", { title: "Replacement" })).rejects.toThrow(/remote delivery has already started/);
  expect(store.get("legacy-state", "queue")).toEqual(original);
  expect(deliveryForPackage(d.package.packageHash)).toEqual(durable);
  expect(readDeliveryHandles(d)).toEqual(handles);
  const q = new WorkQueue(store);
  await q.enqueue({ kind: "fixture", workKey: "reconcile", inputRevision: 1, payload: {} });
  const lease = (await q.claim("test"))!;
  let inits = 0;
  await withWork({ queue: q, lease, workspace: OUTPUT_ROOT, signal: new AbortController().signal }, async () => {
    await reconcileDelivery(d.id, { token: async () => "fake", fetch: (async (url, init) => {
      if (init?.method === "POST") inits++;
      return Response.json({ items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] });
    }) as typeof fetch });
  });
  expect(inits).toBe(0);
  expect(store.list("deliveries")).toHaveLength(1);
});
it("Studio pre-intent review replacement still succeeds", async () => {
  publicationFixture();
  const file = await media(), digest = await checksum(file), store = runtimeStore();
  store.put("projects", "p", { id: "p", revision: 1, name: "Studio" });
  store.put("renders", "r", { id: "r", projectId: "p", revision: 1, checksum: digest, path: file });
  const old = await prepareRenderReview("p", "r", digest, "youtube", { title: "Old" });
  const next = await prepareRenderReview("p", "r", digest, "youtube", { title: "New" });
  expect(next.publishPackage?.packageHash).not.toBe(old.publishPackage?.packageHash);
});
