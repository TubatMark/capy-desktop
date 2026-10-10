import { afterAll, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

// OUTPUT_ROOT and the data folder resolve at import: point both at a temp folder first
const env = vi.hoisted(() => {
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const p = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-source-thumbs-"));
  process.env.CAPY_OUTPUT = p.join(root, "out");
  process.env.CAPY_DATA_DIR = p.join(root, "data");
  return { root };
});

import { run } from "../src/exec";
import { checksum } from "../server/studio/assets";
import { DEFAULT_AI_ROUTING } from "../lib/ai-policy";
import { DEFAULT_CREATOR_POLICY } from "../lib/creator-policy";
import type { ThumbnailDesign } from "../lib/thumbnails";
import type { QueueEntry } from "../lib/types";
import { runtimeStore } from "../server/db/runtime";
import { WorkQueue } from "../server/worker/leases";
import { runJob } from "../server/worker/runner";
import { OUTPUT_ROOT } from "../server/paths";
import {
  generateThumbnails,
  listThumbnails,
  thumbnailDependencies,
  thumbnailStages,
  type ThumbnailDependencies,
} from "../server/thumbnails";
import {
  approveThumbnail,
  exportThumbnail,
  getThumbnail,
  saveThumbnail,
  switchQueueThumbnail,
} from "../server/thumbnail-studio";
import {
  getAutomationPublicationChecks,
  saveCreatorPolicy,
} from "../server/automation-policy";
import { buildPublishPackage, decide } from "../server/publication-policy";
import { publicQueueEntry } from "../server/queue";
import {
  jpegSize,
  sourceThumbnail,
  sourceThumbnailUrl,
  type FetchImage,
} from "../server/source-thumbnail";
import { publicationFixture } from "./publication-fixtures";

afterAll(() => rmSync(env.root, { recursive: true, force: true }));

const STALE =
  "Selected thumbnail revision, provenance or composition is stale or failed";
const VIDEO = "dQw4w9WgXcQ";
const BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";

/** A stand-in for a creator's professionally made 16:9 YouTube thumbnail. */
async function fixtureThumbnail(file: string, size = "1280x720") {
  mkdirSync(path.dirname(file), { recursive: true });
  const [w, h] = size.split("x").map(Number) as [number, number];
  const font = existsSync(BOLD)
    ? `fontfile=${BOLD.replace(/ /g, "\\ ")}:`
    : "";
  const text = (t: string, s: number, c: string, x: number, y: number) =>
    `drawtext=${font}text='${t}':fontsize=${Math.round(s * (w / 1280))}:fontcolor=${c}:borderw=${Math.round(8 * (w / 1280))}:bordercolor=black:x=${Math.round(x * (w / 1280))}:y=${Math.round(y * (h / 720))}`;
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=${size}:c0=0xff3d00:c1=0x2a0a6b:x0=0:y0=0:x1=${w}:y1=${h}:seed=7:d=1`,
    "-vf",
    [
      `drawbox=x=${Math.round(w * 0.6)}:y=${Math.round(h * 0.15)}:w=${Math.round(w * 0.32)}:h=${Math.round(h * 0.68)}:color=0x00e5ff@0.9:t=fill`,
      text("1 VS 5", 150, "white", 60, 200),
      text("CLUTCH?!", 120, "yellow", 60, 380),
    ].join(","),
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    file,
  ]);
  return readFileSync(file);
}

it("fetches the best usable source thumbnail once, skipping 404s and YouTube's grey placeholder", async () => {
  const dir = path.join(OUTPUT_ROOT, "fetch-a");
  const placeholder = await fixtureThumbnail(
    path.join(env.root, "fixtures", "placeholder.jpg"),
    "120x90",
  );
  const hq = await fixtureThumbnail(
    path.join(env.root, "fixtures", "hq.jpg"),
    "480x360",
  );
  expect(jpegSize(hq)).toEqual({ width: 480, height: 360 });
  expect(jpegSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  const asked: string[] = [];
  const fetcher: FetchImage = async (url) => {
    asked.push(url);
    if (url.endsWith("/maxresdefault.jpg")) return undefined; // 404
    if (url.endsWith("/sddefault.jpg")) return placeholder;
    return hq;
  };
  const signal = new AbortController().signal;
  const found = await sourceThumbnail({ videoId: VIDEO, directory: dir }, signal, fetcher);
  expect(asked).toEqual(
    ["maxresdefault", "sddefault", "hqdefault"].map((s) =>
      sourceThumbnailUrl(VIDEO, s),
    ),
  );
  expect(found).toMatchObject({
    videoId: VIDEO,
    url: `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`,
    width: 480,
    height: 360,
  });
  expect(found!.checksum).toBe(await checksum(found!.path));
  expect(path.dirname(found!.path)).toBe(dir);

  // cached: the second clip of the same video never asks the network
  const again = await sourceThumbnail({ videoId: VIDEO, directory: dir }, signal, async () => {
    throw Error("must not fetch again");
  });
  expect(again).toEqual(found);

  // offline, or an ID that isn't a YouTube video: nothing, without throwing
  expect(
    await sourceThumbnail({ videoId: "abcdefghijk", directory: path.join(OUTPUT_ROOT, "fetch-b") }, signal, async () => {
      throw Error("getaddrinfo ENOTFOUND i.ytimg.com");
    }),
  ).toBeUndefined();
  expect(
    await sourceThumbnail({ videoId: "../../etc", directory: dir }, signal, fetcher),
  ).toBeUndefined();
});

/** One automatic Monitor clip with its YouTube post waiting in review, run through the thumbnail stages. */
async function automaticClip(jobId: string, fetchImage: FetchImage) {
  const store = runtimeStore();
  publicationFixture();
  const jobDir = `${jobId}-dir`;
  const file = path.join(OUTPUT_ROOT, jobDir, "clip-1.mp4");
  mkdirSync(path.dirname(file), { recursive: true });
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=180x320:rate=6:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    file,
  ]);
  const p = saveCreatorPolicy(`${jobId}-chan`, {
    ...DEFAULT_CREATOR_POLICY,
    thumbnailGeneration: "automatic",
    mode: "automatic_drafts",
    destinationAccountIds: ["fixture-account"],
    requireModelReview: false,
  });
  store.put("automation-jobs", jobId, {
    channelId: `${jobId}-chan`,
    recipeId: p.recipeId,
  });
  store.put("legacy-jobs", jobId, {
    id: jobId,
    videoId: VIDEO,
    url: `https://www.youtube.com/watch?v=${VIDEO}`,
    dir: jobDir,
    clips: [
      {
        n: 1,
        start: 0,
        end: 2,
        title: "He wins the 1v5",
        hook: "One bullet left",
        render: { status: "done", file },
      },
    ],
  });
  const raw = path.join(OUTPUT_ROOT, jobDir, "clip-1.jpg");
  await run("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-y", raw]);
  store.put("legacy-state", "queue", [
    {
      key: `${jobId}:1:youtube`,
      jobId,
      n: 1,
      platform: "youtube",
      status: "review",
      clipTitle: "He wins the 1v5",
      text: { title: "He wins the 1v5" },
      attempts: 0,
      history: [],
      createdAt: 1,
      updatedAt: 1,
      publicationFiles: { file, thumbFile: raw },
    } as QueueEntry,
  ]);
  const source = {
    kind: "legacy" as const,
    jobId,
    clipN: 1,
    revision: store.get("legacy-jobs", jobId)!.revision,
    renderChecksum: await checksum(file),
  };
  const deps: ThumbnailDependencies = {
    ...thumbnailDependencies(),
    store,
    root: OUTPUT_ROOT,
    queue: new WorkQueue(store),
    provider: undefined,
    settings: { ...DEFAULT_AI_ROUTING },
    fetchImage,
    ask: async (_prompt, o) => ({
      data: {
        ranking: [o.images.at(-1)!.label!.replace("Frame ", "")],
        headline: "One bullet left to win",
        layout: "bold",
      },
    }),
  };
  const job = await generateThumbnails(
    {
      source,
      aspect: "portrait",
      headline: "One bullet left",
      mode: "automatic",
      allowCloud: false,
      clipContext: { title: "He wins the 1v5", hook: "One bullet left" },
    },
    deps,
  );
  const lease = await deps.queue.claim("test");
  expect(lease!.id).toBe(job.id);
  await runJob(lease!, new AbortController().signal, {
    queue: deps.queue,
    stages: thumbnailStages(deps),
    artifactRoot: OUTPUT_ROOT,
  });
  const done = deps.queue.get(job.id)!;
  expect(done.status).toBe("complete");
  const entry = () =>
    store
      .get<QueueEntry[]>("legacy-state", "queue")!
      .value.find((e) => e.key === `${jobId}:1:youtube`)!;
  return {
    store,
    deps,
    source,
    done,
    entry,
    designs: done.checkpoint.designs as ThumbnailDesign[],
  };
}

it("the source video's own thumbnail becomes the first design, is attached, and passes the publication gate", async () => {
  const fixture = await fixtureThumbnail(
    path.join(env.root, "fixtures", "maxres.jpg"),
  );
  const asked: string[] = [];
  const { store, deps, source, done, designs, entry } = await automaticClip(
    "orig",
    async (url) => {
      asked.push(url);
      return url.endsWith("/maxresdefault.jpg") ? fixture : undefined;
    },
  );
  expect(asked).toEqual([sourceThumbnailUrl(VIDEO, "maxresdefault")]);
  expect(designs.map((d) => d.layout)).toEqual([
    "original",
    "bold",
    "editorial",
    "minimal",
  ]);
  const original = designs[0]!;
  expect(original.sourceFrames).toEqual([]);
  expect(original.sourceThumbnail).toEqual({
    videoId: VIDEO,
    url: sourceThumbnailUrl(VIDEO, "maxresdefault"),
    checksum: await checksum(path.join(OUTPUT_ROOT, "orig-dir", `source-thumbnail-${VIDEO}.jpg`)),
  });
  expect(original.layers.find((l) => l.kind === "text")?.text).toBe(
    "One bullet left to win",
  );
  const jpg = original.versions.find((v) => v.format === "jpg")!;
  expect([jpg.width, jpg.height]).toEqual([1080, 1920]);
  expect(await checksum(jpg.path)).toBe(jpg.checksum);
  // a sample for the owner to look at
  mkdirSync(path.join(process.cwd(), "test-results"), { recursive: true });
  copyFileSync(
    jpg.path,
    path.join(process.cwd(), "test-results", "source-thumbnail-original.jpg"),
  );

  // not stale: its provenance is the source thumbnail, not a frame
  expect(
    listThumbnails(source, deps).find((d) => d.id === original.id)?.reviewState,
  ).toBe("pending");

  // the original is the one put on the post, and the Queue lists it first as "original"
  expect(done.checkpoint.attached).toEqual(["orig:1:youtube"]);
  const attached = entry();
  expect(attached.publishPackage?.thumbnail?.designId).toBe(original.id);
  expect(attached.publishPackage?.thumbnail?.sourceThumbnail).toEqual(
    original.sourceThumbnail,
  );
  expect(attached.publishPackage?.thumbnail?.sourceFrame).toBeUndefined();
  const shown = publicQueueEntry(attached);
  expect(shown.thumbnailOptions?.map((o) => o.layout)).toEqual([
    "original",
    "bold",
    "editorial",
    "minimal",
  ]);
  expect(shown.thumbnailOptions?.[0]).toMatchObject({
    designId: original.id,
    attached: true,
  });

  // the publication gate accepts the source-thumbnail provenance through approval
  const approved = decide(attached, false, new Date());
  expect(approved.publishPackage!.thumbnail).toEqual(
    attached.publishPackage!.thumbnail,
  );
  expect(getAutomationPublicationChecks(approved).reasons).not.toContain(STALE);

  // ...but not a package that swaps in a frame, or a different source thumbnail
  const { packageHash: _h, ...manifest } = approved.publishPackage!;
  const variant = (thumbnail: object) =>
    ({
      ...approved,
      publishPackage: buildPublishPackage({
        ...manifest,
        thumbnail: { ...manifest.thumbnail!, ...thumbnail },
      }),
    }) as QueueEntry;
  const frame = {
    id: "frame",
    assetId: "source",
    sourceUs: 0,
    renderUs: 0,
    checksum: "1".repeat(64),
  };
  expect(
    getAutomationPublicationChecks(
      variant({ sourceThumbnail: undefined, sourceFrame: frame }),
    ).reasons,
  ).toContain(STALE);
  expect(
    getAutomationPublicationChecks(
      variant({
        sourceThumbnail: { ...original.sourceThumbnail!, checksum: "2".repeat(64) },
      }),
    ).reasons,
  ).toContain(STALE);

  // a frame design attached without its frame stays stale, even when it names a source thumbnail
  const frameDesign = designs[1]!;
  const switched = await switchQueueThumbnail("orig:1:youtube", frameDesign.id, deps);
  expect(switched.publishPackage!.thumbnail!.sourceFrame).toBeDefined();
  const frameApproved = decide(switched, false, new Date());
  expect(getAutomationPublicationChecks(frameApproved).reasons).not.toContain(
    STALE,
  );
  const { packageHash: _f, ...frameManifest } = frameApproved.publishPackage!;
  expect(
    getAutomationPublicationChecks({
      ...frameApproved,
      publishPackage: buildPublishPackage({
        ...frameManifest,
        thumbnail: {
          ...frameManifest.thumbnail!,
          sourceFrame: undefined,
          sourceThumbnail: original.sourceThumbnail,
        },
      }),
    }).reasons,
  ).toContain(STALE);

  // switching back to the original works from the Queue too
  const back = await switchQueueThumbnail("orig:1:youtube", original.id, deps);
  expect(back.publishPackage!.thumbnail!.sourceThumbnail).toEqual(
    original.sourceThumbnail,
  );

  // Studio: approve, export in another shape, edit the headline; its picture can't be swapped for a frame
  const doc = getThumbnail(original.id, undefined, deps);
  expect((await approveThumbnail(original.id, doc.editRevision, deps)).state).toBe(
    "approved",
  );
  const landscape = await exportThumbnail(
    original.id,
    doc.editRevision,
    { aspect: "landscape", format: "jpg", text: true },
    deps,
  );
  expect([landscape.width, landscape.height]).toEqual([1920, 1080]);
  const saved = await saveThumbnail(
    {
      ...doc,
      layers: doc.layers.map((l) =>
        l.kind === "text" ? { ...l, text: "Last bullet" } : l,
      ),
    },
    doc.editRevision,
    deps,
  );
  expect(saved.sourceFrames).toEqual([]);
  expect(saved.sourceThumbnail).toEqual(original.sourceThumbnail);
  await expect(
    saveThumbnail(
      {
        ...saved,
        layers: saved.layers.map((l) =>
          l.id === "source" ? { ...l, assetId: "frame-0" } : l,
        ),
      },
      saved.editRevision,
      deps,
    ),
  ).rejects.toThrow(/original video's thumbnail/);
  expect(store.get("thumbnails", original.id)!.revision).toBe(saved.editRevision);
}, 180_000);

it("staleness: a frame design without frames, or an original design without its source thumbnail, is stale", () => {
  const store = runtimeStore();
  store.put("legacy-jobs", "prov", {
    id: "prov",
    videoId: VIDEO,
    clips: [{ n: 1, render: { status: "done" } }],
  });
  const source = {
    kind: "legacy" as const,
    jobId: "prov",
    clipN: 1,
    revision: store.get("legacy-jobs", "prov")!.revision,
    renderChecksum: "0".repeat(64),
  };
  const design = (id: string, over: Partial<ThumbnailDesign>): ThumbnailDesign => ({
    id,
    name: id,
    sourceIdentity: source,
    renderChecksum: source.renderChecksum,
    sourceFrames: [{ assetId: "source", sourceUs: 0, checksum: "1".repeat(64) }],
    aspectPreset: "portrait",
    layout: "bold",
    layers: [],
    versions: [],
    provenance: { provider: "local", model: "none", prompt: "", capability: "local-composition" },
    imageGeneration: { status: "unavailable", accounting: "local" },
    generationState: "ready",
    reviewState: "pending",
    ...over,
  });
  const thumb = {
    videoId: VIDEO,
    url: sourceThumbnailUrl(VIDEO, "maxresdefault"),
    checksum: "3".repeat(64),
  };
  for (const d of [
    design("prov-frame", {}),
    design("prov-frame-missing", { sourceFrames: [] }),
    design("prov-original", { layout: "original", sourceFrames: [], sourceThumbnail: thumb }),
    design("prov-original-missing", { layout: "original", sourceFrames: [] }),
    design("prov-original-other-video", {
      layout: "original",
      sourceFrames: [],
      sourceThumbnail: { ...thumb, videoId: "zzzzzzzzzzz" },
    }),
    design("prov-frame-claims-thumb", { sourceThumbnail: thumb }),
  ])
    store.put("thumbnails", d.id, d);
  const deps = { ...thumbnailDependencies(), store };
  const states = Object.fromEntries(
    listThumbnails(source, deps).map((d) => [d.id, d.reviewState]),
  );
  expect(states).toEqual({
    "prov-frame": "pending",
    "prov-frame-missing": "stale",
    "prov-original": "pending",
    "prov-original-missing": "stale",
    "prov-original-other-video": "stale",
    "prov-frame-claims-thumb": "stale",
  });
});

it("falls back silently to the frame designs when the source thumbnail can't be fetched", async () => {
  const { designs, done, entry } = await automaticClip("offline", async () => {
    throw Error("getaddrinfo ENOTFOUND i.ytimg.com");
  });
  expect(designs.map((d) => d.layout)).toEqual(["bold", "editorial", "minimal"]);
  expect(designs.every((d) => !d.sourceThumbnail && d.sourceFrames.length)).toBe(true);
  expect(done.checkpoint.attached).toEqual(["offline:1:youtube"]);
  expect(entry().publishPackage?.thumbnail?.designId).toBe(designs[0]!.id);
  expect(entry().publishPackage?.thumbnail?.sourceFrame).toBeDefined();
  expect(publicQueueEntry(entry()).thumbnailOptions?.map((o) => o.layout)).not.toContain(
    "original",
  );
}, 180_000);
