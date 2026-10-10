import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/db";
import { WorkQueue } from "../server/worker/leases";
import { runJob } from "../server/worker/runner";
import { run } from "../src/exec";
import { checksum } from "../server/studio/assets";
import { DEFAULT_AI_ROUTING } from "../lib/ai-policy";
import {
  generateThumbnails,
  thumbnailStages,
  thumbnailDependencies,
  listThumbnails,
} from "../server/thumbnails";
import {
  saveThumbnail,
  getThumbnail,
  exportThumbnail,
  exportThumbnailZip,
  attachThumbnail,
} from "../server/thumbnail-studio";
import {
  buildPublishPackage,
  hashManifest,
  eligibility,
} from "../server/publication-policy";
import type { QueueEntry } from "../lib/types";
import type { ThumbnailDependencies } from "../server/thumbnails";
const roots: string[] = [],
  stores: Store[] = [];
afterEach(async () => {
  stores.splice(0).forEach((s) => s.close());
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "capy-thumb-export-"));
  roots.push(root);
  const store = new Store(path.join(root, "db.sqlite"));
  stores.push(store);
  const file = path.join(root, "clip.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=6:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    file,
  ]);
  store.put(
    "legacy-jobs",
    "job",
    {
      id: "job",
      clips: [
        {
          n: 1,
          start: 0,
          end: 2,
          title: "Source",
          render: { status: "done", file },
        },
      ],
    },
    4,
  );
  const source = {
    kind: "legacy" as const,
    jobId: "job",
    clipN: 1,
    revision: 4,
    renderChecksum: await checksum(file),
  };
  const deps = {
    ...thumbnailDependencies(),
    store,
    root,
    queue: new WorkQueue(store),
    provider: undefined,
    settings: { ...DEFAULT_AI_ROUTING },
  };
  const job = await generateThumbnails(
    { source, aspect: "landscape", headline: "Real source", allowCloud: false },
    deps,
  );
  const lease = await deps.queue.claim("test");
  expect(lease?.id).toBe(job.id);
  await runJob(lease!, new AbortController().signal, {
    queue: deps.queue,
    stages: thumbnailStages(deps),
    artifactRoot: root,
  });
  const design = getThumbnail(
    listThumbnails(source, deps)[0]!.id,
    undefined,
    deps,
  );
  return { root, store, source, deps, design, file };
}
it("edit_text_does_not_regenerate and CAS preserves saved history", async () => {
  const f = await fixture();
  const calls = f.store.list("ai-run").length;
  const reservations = f.store.list("ai-reservation");
  let providerCalls = 0;
  const localDeps: ThumbnailDependencies = {
    ...f.deps,
    provider: {
      id: "forbidden-during-edit",
      model: "fixture",
      local: false,
      capabilities: {
        referenceImages: true,
        imageGeneration: true,
        preserveSubject: true,
        providerQuotaBound: false,
      },
      bounds: { costUsd: 0.1, requests: 1, tokens: 100, basis: "estimated" },
      generate: async () => {
        providerCalls++;
        throw Error("Local edits must not call image generation");
      },
    },
  };
  const edited = structuredClone(f.design);
  const title = edited.layers.find((l) => l.kind === "text")!;
  title.text = "LOCAL TITLE";
  title.color = "ff0000";
  title.fontFamily = "Arial";
  delete title.textLayout;
  const image = edited.layers.find((l) => l.id === "source")!;
  image.x += 10;
  image.width -= 10;
  image.crop = { x: 0.1, y: 0.1, width: 0.7, height: 0.8 };
  const saved = await saveThumbnail(edited, f.design.editRevision, localDeps);
  expect(saved.editRevision).toBe(f.design.editRevision + 1);
  expect(getThumbnail(saved.id, undefined, f.deps).layers).toEqual(
    saved.layers,
  );
  expect(f.store.list("ai-run").length).toBe(calls);
  expect(f.store.list("ai-reservation")).toEqual(reservations);
  expect(providerCalls).toBe(0);
  expect(getThumbnail(saved.id, f.design.editRevision, f.deps).layers).toEqual(
    f.design.layers,
  );
  await expect(
    saveThumbnail(edited, f.design.editRevision, f.deps),
  ).rejects.toThrow(/revision conflict/i);
  const foreign = structuredClone(saved);
  foreign.layers.find((l) => l.id === "source")!.assetId = "foreign";
  await expect(
    saveThumbnail(foreign, saved.editRevision, f.deps),
  ).rejects.toThrow(/frame/);
});
it("historical landscape restore retains exact geometry, crop and PNG pixels after portrait", async () => {
  const f = await fixture();
  const edited = structuredClone(f.design);
  edited.layers.find((l) => l.id === "source")!.crop = {
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.8,
  };
  edited.layers.find((l) => l.id === "source")!.x += 12;
  edited.layers.find((l) => l.kind === "text")!.x += 15;
  const landscape = await saveThumbnail(edited, edited.editRevision, f.deps);
  const { approveThumbnail } = await import("../server/thumbnail-studio");
  const audit = await approveThumbnail(
    landscape.id,
    landscape.editRevision,
    f.deps,
  );
  const portrait = await saveThumbnail(
    { ...landscape, aspectPreset: "portrait" },
    landscape.editRevision,
    f.deps,
  );
  const historical = getThumbnail(landscape.id, landscape.editRevision, f.deps);
  const restored = await saveThumbnail(
    { ...historical, editRevision: portrait.editRevision },
    portrait.editRevision,
    f.deps,
    { restoredFromRevision: historical.editRevision },
  );
  expect(restored.editRevision).toBe(portrait.editRevision + 1);
  expect(restored.aspectPreset).toBe("landscape");
  expect(restored.layers).toEqual(landscape.layers);
  expect(getThumbnail(restored.id, undefined, f.deps).layers).toEqual(
    landscape.layers,
  );
  const before = landscape.versions.filter((v) => v.format === "png").at(-1)!;
  const after = restored.versions.filter((v) => v.format === "png").at(-1)!;
  expect(await readFile(after.path)).toEqual(await readFile(before.path));
  expect(restored.reviewState).toBe("pending");
  expect(
    getThumbnail(historical.id, historical.editRevision, f.deps).reviewState,
  ).toBe("approved");
  expect(
    f.store.get(
      "thumbnail-reviews",
      `${historical.id}:${historical.editRevision}`,
    )?.value,
  ).toEqual(audit);
  await expect(
    saveThumbnail(restored, restored.editRevision, f.deps, {
      restoredFromRevision: 999,
    }),
  ).rejects.toThrow(/revision not found/);
  const overflow = structuredClone(restored);
  overflow.layers.find((l) => l.id === "source")!.width = 5000;
  await expect(
    saveThumbnail(overflow, restored.editRevision, f.deps, {
      restoredFromRevision: historical.editRevision,
    }),
  ).rejects.toThrow(/exceed canvas/);
  f.store.put("thumbnail-history", `${restored.id}:999`, {
    ...historical,
    sourceIdentity: { ...historical.sourceIdentity, renderChecksum: "foreign" },
  });
  await expect(
    saveThumbnail(restored, restored.editRevision, f.deps, {
      restoredFromRevision: 999,
    }),
  ).rejects.toThrow(/source identity does not match/);
  const square = await saveThumbnail(
    {
      ...historical,
      editRevision: restored.editRevision,
      aspectPreset: "square",
    },
    restored.editRevision,
    f.deps,
    { restoredFromRevision: historical.editRevision },
  );
  const expectedSquare = await exportThumbnail(
    historical.id,
    historical.editRevision,
    { aspect: "square", format: "png", text: true },
    f.deps,
  );
  expect(
    await readFile(
      square.versions.filter((v) => v.format === "png").at(-1)!.path,
    ),
  ).toEqual(await readFile(expectedSquare.path));
});
it("download_outputs_are_real_and_correct", async () => {
  const f = await fixture();
  for (const aspect of ["landscape", "portrait", "square"] as const)
    for (const format of ["png", "jpg"] as const) {
      const out = await exportThumbnail(
        f.design.id,
        f.design.editRevision,
        { aspect, format, text: false },
        f.deps,
      );
      const bytes = await readFile(out.path);
      expect(bytes.subarray(0, format === "png" ? 8 : 3)).toEqual(
        format === "png"
          ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
          : Buffer.from([255, 216, 255]),
      );
      const probe = JSON.parse(
        (
          await run("ffprobe", [
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
            out.path,
          ])
        ).stdout,
      );
      expect([probe.streams[0].width, probe.streams[0].height]).toEqual(
        aspect === "landscape"
          ? [1920, 1080]
          : aspect === "portrait"
            ? [1080, 1920]
            : [1080, 1080],
      );
      expect(out.layers.find((l) => l.kind === "text")!.text).toBe(
        "Real source",
      );
    }
  const zip = await exportThumbnailZip(
    [
      {
        id: f.design.id,
        revision: f.design.editRevision,
        options: { aspect: "square", format: "png", text: false },
      },
      {
        id: f.design.id,
        revision: f.design.editRevision,
        options: { aspect: "portrait", format: "jpg", text: true },
      },
    ],
    f.deps,
  );
  expect(zip.bytes.subarray(0, 4)).toEqual(Buffer.from([80, 75, 3, 4]));
  expect(zip.filenames).toEqual([
    `${f.design.id}-r${f.design.editRevision}-square-no-text.png`,
    `${f.design.id}-r${f.design.editRevision}-portrait.jpg`,
  ]);
  const probe = await run("python3", [
    "-c",
    "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print('|'.join(z.namelist()));assert z.testzip() is None",
    zip.path,
  ]);
  expect(probe.stdout.trim().split("|")).toEqual(zip.filenames);
}, 60000);
it("thumbnail_change_invalidates_package but downloading does not", async () => {
  const f = await fixture();
  const text = { title: "Video" };
  const pkg = buildPublishPackage({
    id: "package",
    artifact: { id: "job:1", checksum: f.source.renderChecksum },
    text,
    textHash: hashManifest(text),
    platform: "youtube",
    accountId: "fixture",
    policyVersion: "publication-v2",
    mediaOptionsHash: hashManifest({}),
    deliveryOptions: { mode: "public", privacyPolicy: "public" },
  });
  const entry = {
    key: "job:1:youtube",
    jobId: "job",
    n: 1,
    platform: "youtube",
    status: "scheduled",
    publishPackage: pkg,
    publicationFiles: { file: f.file },
    publicationDecision: { kind: "human", packageHash: pkg.packageHash, at: 1 },
    history: [],
    updatedAt: 1,
  } as unknown as QueueEntry;
  f.store.put("legacy-state", "queue", [entry], 2);
  await exportThumbnail(
    f.design.id,
    f.design.editRevision,
    { aspect: "landscape", format: "png", text: true },
    f.deps,
  );
  expect(f.store.get("legacy-state", "queue")?.revision).toBe(2);
  const attached = await attachThumbnail(
    pkg.id,
    f.design.id,
    f.design.editRevision,
    f.deps,
  );
  expect(attached.packageHash).not.toBe(pkg.packageHash);
  expect(pkg.thumbnail).toBeUndefined();
  const queue = f.store.get<QueueEntry[]>("legacy-state", "queue")!.value;
  expect(queue[0]!.publicationDecision).toBeUndefined();
  expect(queue[0]!.status).toBe("review");
  expect(
    eligibility(
      { ...queue[0]!, text, publicationDecision: entry.publicationDecision },
      queue[0]!.publicationFiles,
      "fixture",
    ).allowed,
  ).toBe(false);
  expect(attached.thumbnail?.sourceFrame?.checksum).toBe(
    f.store.get<{ checksum: string }>(
      "thumbnail-frames",
      f.design.layers.find((l) => l.id === "source")!.assetId!,
    )!.value.checksum,
  );
  await expect(
    attachThumbnail(pkg.id, f.design.id, f.design.editRevision, f.deps),
  ).rejects.toThrow(/package/i);
});
it("aspect reflow fits actual text ink and crop keeps the selected original pixels", async () => {
  const { execFileSync } = await import("node:child_process");
  const f = await fixture();
  const decode = (file: string) =>
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { maxBuffer: 20000000 },
    );
  for (const aspect of ["landscape", "portrait", "square"] as const) {
    const withText = await exportThumbnail(
        f.design.id,
        f.design.editRevision,
        { aspect, format: "png", text: true },
        f.deps,
      ),
      without = await exportThumbnail(
        f.design.id,
        f.design.editRevision,
        { aspect, format: "png", text: false },
        f.deps,
      );
    const a = decode(withText.path),
      b = decode(without.path),
      layer = withText.layers.find((l) => l.kind === "text")!;
    let count = 0;
    for (let i = 0; i < a.length; i += 3) {
      if (
        Math.max(
          Math.abs(a[i]! - b[i]!),
          Math.abs(a[i + 1]! - b[i + 1]!),
          Math.abs(a[i + 2]! - b[i + 2]!),
        ) < 40
      )
        continue;
      count++;
      const pixel = i / 3,
        x = pixel % withText.width,
        y = Math.floor(pixel / withText.width);
      expect(
        x >= layer.x &&
          x < layer.x + layer.width &&
          y >= layer.y &&
          y < layer.y + layer.height,
        `${aspect} ink at ${x},${y}; bounds ${layer.x},${layer.y},${layer.width},${layer.height}; color ${a.subarray(i, i + 3)} vs ${b.subarray(i, i + 3)}`,
      ).toBe(true);
    }
    expect(count).toBeGreaterThan(50);
    if (aspect !== "landscape")
      expect(
        withText.layers.find((l) => l.kind === "text")!.x / withText.width,
      ).not.toBeCloseTo(
        f.design.layers.find((l) => l.kind === "text")!.x / 1920,
        2,
      );
  }
  const selected = f.design.layers.find((l) => l.id === "source")!.assetId!,
    frame = f.store.get<any>("thumbnail-frames", selected)!;
  const file = path.join(f.root, "red-blue.png");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x180,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill",
    "-frames:v",
    "1",
    "-y",
    file,
  ]);
  f.store.put("thumbnail-frames", selected, {
    ...frame.value,
    path: file,
    checksum: await checksum(file),
  });
  const edited = structuredClone(f.design);
  const image = edited.layers.find((l) => l.id === "source")!;
  image.crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
  const saved = await saveThumbnail(edited, edited.editRevision, f.deps);
  const exported = await exportThumbnail(
    saved.id,
    saved.editRevision,
    { aspect: "landscape", format: "png", text: false },
    f.deps,
  );
  const bytes = decode(exported.path),
    pixel =
      (Math.floor(image.y + image.height / 2) * 1920 +
        Math.floor(image.x + image.width / 2)) *
      3;
  expect(bytes[pixel + 2]).toBeGreaterThan(240);
  expect(bytes[pixel]).toBeLessThan(10);
  const invalid = structuredClone(saved);
  invalid.layers.find((l) => l.id === "source")!.crop = {
    x: 0.9,
    y: 0,
    width: 0.5,
    height: 1,
  };
  await expect(
    saveThumbnail(invalid, saved.editRevision, f.deps),
  ).rejects.toThrow(/crop/);
}, 60000);
it("failed and late explicit regeneration preserve selected design", async () => {
  const { regenerateThumbnail, resolveRegeneration } =
    await import("../server/thumbnail-studio");
  const f = await fixture();
  const original = structuredClone(f.design);
  const failed = await regenerateThumbnail(
    original.id,
    original.editRevision,
    "background",
    "failure",
    f.deps,
  );
  const work = f.deps.queue.get(failed.jobId)!;
  f.store.put("work", work.id, {
    ...work,
    status: "needs_action",
    error: "fixture provider refused",
  });
  expect((await resolveRegeneration(failed.id, f.deps)).state).toBe("failed");
  expect(getThumbnail(original.id, undefined, f.deps)).toEqual(original);
  const pending = await regenerateThumbnail(
    original.id,
    original.editRevision,
    "variation",
    "late",
    f.deps,
  );
  const duplicate = await regenerateThumbnail(
    original.id,
    original.editRevision,
    "variation",
    "late",
    f.deps,
  );
  expect(duplicate.jobId).toBe(pending.jobId);
  const edited = structuredClone(original);
  edited.name = "Concurrent local edit";
  const saved = await saveThumbnail(edited, original.editRevision, f.deps);
  const queued = f.deps.queue.get(pending.jobId)!;
  f.store.put("work", queued.id, {
    ...queued,
    status: "complete",
    checkpoint: { designs: [original] },
  });
  expect((await resolveRegeneration(pending.id, f.deps)).state).toBe(
    "conflict",
  );
  expect(getThumbnail(original.id, undefined, f.deps)).toEqual(saved);
});
it("explicit background regeneration spends one fixture call and applies atomically once", async () => {
  const { regenerateThumbnail, resolveRegeneration, listStudioThumbnails } =
    await import("../server/thumbnail-studio");
  const f = await fixture();
  let calls = 0;
  const deps: ThumbnailDependencies = {
    ...f.deps,
    provider: {
      id: "fixture-image",
      model: "fixture-background",
      local: false,
      capabilities: {
        referenceImages: true,
        imageGeneration: true,
        preserveSubject: true,
        providerQuotaBound: false,
      },
      bounds: { costUsd: 0.1, requests: 1, tokens: 100, basis: "estimated" },
      generate: async ({ outputDirectory, frames }) => {
        calls++;
        expect(frames).toHaveLength(1);
        expect(frames[0]!.id).toBe(
          f.design.layers.find((l) => l.id === "source")!.assetId,
        );
        await mkdir(outputDirectory, { recursive: true });
        const file = path.join(outputDirectory, "background.png");
        await run("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=orange:s=320x180",
          "-frames:v",
          "1",
          "-y",
          file,
        ]);
        return {
          provider: "fixture-image",
          model: "fixture-background",
          assets: [
            { path: file, kind: "background", checksum: await checksum(file) },
          ],
          cost: { basis: "reported", value: 0.02, currency: "USD" },
          usage: { requests: 1, tokens: 12 },
        };
      },
    },
  };
  const record = await regenerateThumbnail(
    f.design.id,
    f.design.editRevision,
    "background",
    "one",
    deps,
  );
  const lease = await deps.queue.claim("fixture");
  expect(lease?.id).toBe(record.jobId);
  await runJob(lease!, new AbortController().signal, {
    queue: deps.queue,
    stages: thumbnailStages(deps),
    artifactRoot: f.root,
  });
  expect(deps.queue.get(record.jobId)?.status).toBe("complete");
  expect(calls).toBe(1);
  const outcomes = await Promise.all([
    resolveRegeneration(record.id, deps),
    resolveRegeneration(record.id, deps),
  ]);
  expect(outcomes.map((r) => r.state)).toEqual(["applied", "applied"]);
  const saved = getThumbnail(f.design.id, undefined, deps);
  expect(saved.editRevision).toBe(f.design.editRevision + 1);
  expect(saved.versions.length).toBe(f.design.versions.length + 2);
  expect(saved.layers.find((l) => l.id === "source")).toEqual(
    f.design.layers.find((l) => l.id === "source"),
  );
  expect(saved.provenance.provider).toBe("fixture-image");
  expect(saved.imageGeneration.status).toBe("available");
  expect(listStudioThumbnails(f.source, deps)).toHaveLength(3);
  expect(calls).toBe(1);
}, 60000);
it("source staleness archives the previous revision and prevents attachment without removing downloads", async () => {
  const { listStudioThumbnails } = await import("../server/thumbnail-studio");
  const f = await fixture();
  const job = f.store.get<any>("legacy-jobs", "job")!;
  // saving the video job (another clip rendering, a field edit) is not staleness: this clip's footage is the same
  f.store.save("legacy-jobs", "job", job.value, job.revision);
  expect(
    listStudioThumbnails(f.source, f.deps).find((d) => d.id === f.design.id)
      ?.reviewState,
  ).not.toBe("stale");
  // re-rendering this clip is
  appendFileSync(job.value.clips[0].render.file, "re-rendered");
  expect(
    listStudioThumbnails(f.source, f.deps).find((d) => d.id === f.design.id)
      ?.reviewState,
  ).toBe("stale");
  expect(
    getThumbnail(f.design.id, f.design.editRevision, f.deps).layers,
  ).toEqual(f.design.layers);
  const out = await exportThumbnail(
    f.design.id,
    f.design.editRevision,
    { aspect: "square", format: "png", text: false },
    f.deps,
  );
  expect((await readFile(out.path)).length).toBeGreaterThan(100);
});
it("explicit review binds immutable historical design without provider, document revision or queue writes", async () => {
  const { approveThumbnail } = await import("../server/thumbnail-studio");
  const { thumbnailReviewManifest } = await import("../lib/thumbnails");
  const f = await fixture();
  const workCount = f.deps.queue.list().length,
    rows = f.store.get("thumbnails", f.design.id)!.revision,
    queue = f.store.get("legacy-state", "queue");
  const audit = await approveThumbnail(
    f.design.id,
    f.design.editRevision,
    f.deps,
  );
  expect(audit.digest).toBe(hashManifest(thumbnailReviewManifest(f.design)));
  expect(getThumbnail(f.design.id, undefined, f.deps).reviewState).toBe(
    "approved",
  );
  expect(f.store.get("thumbnails", f.design.id)!.revision).toBe(rows);
  expect(f.store.get("legacy-state", "queue")).toEqual(queue);
  expect(f.deps.queue.list().length).toBe(workCount);
  expect(
    await approveThumbnail(f.design.id, f.design.editRevision, f.deps),
  ).toEqual(audit);
  const edited = structuredClone(getThumbnail(f.design.id, undefined, f.deps));
  edited.layers.find((l) => l.kind === "text")!.text = "Changed local headline";
  const saved = await saveThumbnail(edited, edited.editRevision, f.deps);
  expect(saved.reviewState).toBe("pending");
  expect(
    getThumbnail(f.design.id, saved.editRevision, f.deps).reviewState,
  ).toBe("pending");
  expect(
    getThumbnail(f.design.id, f.design.editRevision, f.deps).reviewState,
  ).toBe("approved");
  const job = f.store.get<any>("legacy-jobs", "job")!;
  appendFileSync(job.value.clips[0].render.file, "re-rendered");
  await expect(
    approveThumbnail(f.design.id, saved.editRevision, f.deps),
  ).rejects.toThrow(/stale|checksum changed/);
});

it("thumbnail writer refuses ambiguous and unprojected durable intent without replacing package or history", async () => {
  const f = await fixture();
  const { runtimeStore } = await import("../server/db/runtime");
  const { publicationFixture } = await import("./publication-fixtures");
  const { upsertForRender } = await import("../server/queue");
  const { decide } = await import("../server/publication-policy");
  const { createDelivery, updateDelivery, readDeliveryHandles, saveDeliveryHandles } = await import("../server/delivery-store");
  const beforeDir = process.env.CAPY_DATA_DIR;
  process.env.CAPY_DATA_DIR = path.join(f.root, "delivery-data");
  try {
    publicationFixture();
    const entry = decide(upsertForRender([], { publicationFiles: { file: f.file }, jobId: "job", n: 1, start: 0, end: 2, clipTitle: "Original" }, ["youtube"], new Date())[0]!, false, new Date());
    const d = createDelivery(entry);
    saveDeliveryHandles(d, { session: "https://fixture/retained", videoId: "remote" });
    updateDelivery(d.id, (value) => ({ ...value, phase: "session-create-intent", state: "delivery-unknown" }));
    for (const collection of ["deliveries", "delivery-identities", "publication-attributions"])
      for (const row of runtimeStore().list(collection)) f.store.put(collection, row.id, row.value);
    const durable = f.store.list("deliveries"), handles = readDeliveryHandles(d);
    for (const status of ["scheduled", "failed", "needs_action"] as const) {
      f.store.put("legacy-state", "queue", [{ ...entry, status }]);
      const before = f.store.get("legacy-state", "queue");
      const history = f.store.list("publication-history");
      await expect(attachThumbnail(entry.publishPackage!.id, f.design.id, f.design.editRevision, f.deps)).rejects.toThrow(/remote delivery has already started|unavailable for attachment/);
      expect(f.store.get("legacy-state", "queue")).toEqual(before);
      expect(f.store.list("deliveries")).toEqual(durable);
      expect(f.store.list("publication-history")).toEqual(history);
      expect(f.store.list("thumbnail-attachments")).toEqual([]);
      expect(readDeliveryHandles(d)).toEqual(handles);
    }
  } finally {
    if (beforeDir === undefined) delete process.env.CAPY_DATA_DIR;
    else process.env.CAPY_DATA_DIR = beforeDir;
  }
}, 60000);
