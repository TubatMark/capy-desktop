import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db";
import { WorkQueue } from "../server/worker/leases";
import { runJob } from "../server/worker/runner";
import { run } from "../src/exec";
import { checksum } from "../server/studio/assets";
import { DEFAULT_AI_ROUTING } from "../lib/ai-policy";
import {
  generateThumbnails,
  thumbnailStages,
  listThumbnails,
  thumbnailDependencies,
} from "../server/thumbnails";
import type { ImageProvider } from "../src/thumbnails/provider";
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  stores.splice(0).forEach((s) => s.close());
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture(provider?: ImageProvider) {
  const root = await mkdtemp(path.join(tmpdir(), "capy-thumbnails-"));
  dirs.push(root);
  const store = new Store(path.join(root, "db.sqlite"));
  stores.push(store);
  const queue = new WorkQueue(store);
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
          start: 3,
          end: 5,
          title: "A useful demonstration",
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
    queue,
    provider,
    settings: { ...DEFAULT_AI_ROUTING },
  };
  async function execute(job: { id: string }) {
    const lease = await queue.claim("test");
    expect(lease!.id).toBe(job.id);
    await runJob(lease!, new AbortController().signal, {
      queue,
      stages: thumbnailStages(deps),
      artifactRoot: root,
    });
    return queue.get(job.id)!;
  }
  return { root, store, queue, source, deps, execute };
}
const provider = (generate: ImageProvider["generate"]): ImageProvider => ({
  id: "fixture-image",
  model: "fixture-v1",
  local: false,
  capabilities: {
    referenceImages: true,
    imageGeneration: true,
    preserveSubject: true,
    providerQuotaBound: false,
  },
  bounds: { costUsd: 0.1, requests: 1, tokens: 1000, basis: "estimated" },
  generate,
});
it("no image adapter creates three useful local templates with editable text and real PNG/JPG", async () => {
  const f = await fixture();
  const job = await generateThumbnails(
    {
      source: f.source,
      aspect: "landscape",
      headline: "A useful demonstration",
    },
    f.deps,
  );
  expect(job.status).toBe("queued");
  expect((await f.execute(job)).status).toBe("complete");
  const designs = listThumbnails(f.source, f.deps);
  expect(designs).toHaveLength(3);
  expect(new Set(designs.map((d) => d.layout)).size).toBe(3);
  expect(new Set(designs.map((d) => d.versions[0]!.checksum)).size).toBe(3);
  for (const design of designs) {
    expect(design.imageGeneration.status).toBe("unavailable");
    expect(
      design.layers.some(
        (l) => l.kind === "text" && l.text === "A useful demonstration",
      ),
    ).toBe(true);
    expect(design.sourceIdentity).toEqual(f.source);
    expect(design.versions).toHaveLength(2);
    for (const version of design.versions) {
      const probe = JSON.parse(
        (
          await run("ffprobe", [
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
            version.path,
          ])
        ).stdout,
      );
      expect(probe.streams[0].width).toBe(1920);
      expect(probe.streams[0].height).toBe(1080);
    }
  }
  expect(f.store.list("ai-reservation")).toHaveLength(0);
}, 90_000);
it("generation_uses_selected_frames only and three faithful distinct briefs", async () => {
  const seen: Parameters<ImageProvider["generate"]>[0][] = [];
  const f = await fixture(
    provider(async (input) => {
      seen.push(input);
      const background = path.join(input.outputDirectory, "background.png");
      await (
        await import("node:fs/promises")
      ).mkdir(input.outputDirectory, { recursive: true });
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=${input.brief.layout === "bold" ? "blue" : input.brief.layout === "editorial" ? "green" : "purple"}:size=320x180`,
        "-frames:v",
        "1",
        "-y",
        background,
      ]);
      return {
        provider: "fixture-image",
        model: "fixture-v1",
        assets: [
          {
            path: background,
            kind: "background",
            checksum: await checksum(background),
          },
        ],
        cost: { basis: "reported", value: 0.01 },
        usage: { requests: 1, tokens: 100 },
      };
    }),
  );
  const candidatesJob = await generateThumbnails(
    {
      source: f.source,
      aspect: "square",
      headline: "Source demonstration",
      action: "frames",
    },
    f.deps,
  );
  await f.execute(candidatesJob);
  const frames = f.store.list<any>("thumbnail-frames").map((r) => r.value);
  const selected = frames.slice(0, 2).map((r) => r.id);
  const job = await generateThumbnails(
    {
      source: f.source,
      aspect: "square",
      headline: "Source demonstration",
      selectedFrameIds: selected,
    },
    f.deps,
  );
  expect((await f.execute(job)).status).toBe("complete");
  expect(seen).toHaveLength(3);
  expect(new Set(seen.map((i) => i.brief.layout)).size).toBe(3);
  for (const input of seen) {
    expect(input.frames.map((f) => f.id)).toEqual(selected);
    expect(input.brief.instructions).toMatch(/identity|expression/);
    expect(input).not.toHaveProperty("transcript");
  }
  expect(f.store.list("ai-reservation")).toHaveLength(1);
}, 90_000);
it("failure_preserves_versions_and_budget across bounded retries and stale edits", async () => {
  const f = await fixture();
  const local = await generateThumbnails(
    { source: f.source, aspect: "square", headline: "Original" },
    f.deps,
  );
  await f.execute(local);
  const before = listThumbnails(f.source, f.deps);
  expect(before).toHaveLength(3);
  let calls = 0;
  f.deps.provider = provider(async () => {
    calls++;
    throw Error("transport failed");
  });
  const failed = await generateThumbnails(
    { source: f.source, aspect: "square", headline: "Regenerate" },
    f.deps,
  );
  expect((await f.execute(failed)).status).toBe("needs_action");
  expect(calls).toBe(2);
  expect(listThumbnails(f.source, f.deps)).toHaveLength(before.length);
  f.deps.settings.maxDayUsd = 0.01;
  const blocked = await generateThumbnails(
    { source: f.source, aspect: "square", headline: "Budget exhausted" },
    f.deps,
  );
  await f.execute(blocked);
  expect(calls).toBe(2);
  const row = f.store.get<any>("legacy-jobs", "job")!;
  appendFileSync(row.value.clips[0].render.file, "re-rendered");
  expect(
    listThumbnails(f.source, f.deps).every((d) => d.reviewState === "stale"),
  ).toBe(true);
}, 90_000);
it("strict quota mode rejects unverified bounds and privacy prevents cloud calls", async () => {
  let calls = 0;
  const f = await fixture(
    provider(async () => {
      calls++;
      throw Error("should not call");
    }),
  );
  f.deps.settings.usageLimitMode = "provider";
  const job = await generateThumbnails(
    { source: f.source, aspect: "square", headline: "Strict" },
    f.deps,
  );
  await f.execute(job);
  expect(calls).toBe(0);
  expect(f.store.list("ai-reservation")).toHaveLength(0);
  f.deps.settings.usageLimitMode = "application";
  f.deps.settings.allowCloud = false;
  const offline = await generateThumbnails(
    { source: f.source, aspect: "square", headline: "Private" },
    f.deps,
  );
  expect((await f.execute(offline)).status).toBe("complete");
  expect(calls).toBe(0);
  expect(listThumbnails(f.source, f.deps)[0]!.imageGeneration.reason).toMatch(
    /cloud/i,
  );
}, 90_000);
it("rejects source-free requests, foreign frames, exact checksum mismatch, and invalid batch sizes", async () => {
  const f = await fixture();
  await expect(
    generateThumbnails(
      {
        source: { ...f.source, renderChecksum: "wrong" },
        aspect: "square",
        headline: "Bad",
      },
      f.deps,
    ),
  ).rejects.toThrow(/checksum/i);
  await expect(
    generateThumbnails(
      { source: f.source, aspect: "square", headline: "Bad", variantCount: 4 },
      f.deps,
    ),
  ).rejects.toThrow(/variant/i);
  await expect(
    generateThumbnails(
      {
        source: f.source,
        aspect: "square",
        headline: "Bad",
        selectedFrameIds: ["unknown"],
      },
      f.deps,
    ),
  ).rejects.toThrow(/frame/i);
}, 30_000);

it("source pixels remain a separate editable layer with persisted provider background assets", async () => {
  const f = await fixture(
    provider(async (input) => {
      const background = path.join(input.outputDirectory, "background.png");
      await (
        await import("node:fs/promises")
      ).mkdir(input.outputDirectory, { recursive: true });
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=purple:size=640x360",
        "-frames:v",
        "1",
        "-y",
        background,
      ]);
      return {
        provider: "fixture-image",
        model: "fixture-v1",
        assets: [
          {
            path: background,
            kind: "background",
            checksum: await checksum(background),
          },
        ],
        cost: { basis: "reported", value: 0.02 },
      };
    }),
  );
  const job = await generateThumbnails(
    {
      source: f.source,
      aspect: "portrait",
      headline: "The source pixels",
      variantCount: 1,
    },
    f.deps,
  );
  const result = await f.execute(job);
  expect(result.status, result.error).toBe("complete");
  const design = listThumbnails(f.source, f.deps)[0]!;
  expect(design.layers.find((l) => l.id === "source")?.assetId).toBeTruthy();
  const background = design.layers.find((l) => l.id === "background")!;
  expect(background.kind).toBe("image");
  const asset = f.store.get<{ path: string; checksum: string }>(
    "thumbnail-assets",
    background.assetId!,
  )!.value;
  expect(await checksum(asset.path)).toBe(asset.checksum);
  for (const version of design.versions) {
    const metadata = JSON.parse(
      (
        await run("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-of",
          "json",
          version.path,
        ])
      ).stdout,
    );
    expect(metadata.streams[0].width).toBe(1080);
    expect(metadata.streams[0].height).toBe(1920);
  }
}, 90_000);
it("cancelled provider work cannot publish designs and keeps spent allowance", async () => {
  let id = "";
  const f = await fixture(
    provider(async () => {
      await f.queue.cancel(id);
      return {
        provider: "fixture-image",
        model: "fixture-v1",
        assets: [],
        cost: { basis: "reported", value: 0.05 },
        usage: { requests: 1, tokens: 10 },
      };
    }),
  );
  const job = await generateThumbnails(
    { source: f.source, aspect: "square", headline: "Cancel me" },
    f.deps,
  );
  id = job.id;
  expect((await f.execute(job)).status).toBe("cancelled");
  expect(listThumbnails(f.source, f.deps)).toHaveLength(0);
  const day = new Date().toISOString().slice(0, 10);
  expect(f.store.get<any>("ai-budget-day", day)!.value.usd).toBe(0.05);
}, 90_000);
it("replaced leases cannot promote late provider results", async () => {
  let id = "";
  const f = await fixture(
    provider(async () => {
      const job = f.queue.get(id)!;
      f.store.put("work", id, {
        ...job,
        generation: job.generation + 1,
        owner: "replacement",
      });
      return {
        provider: "fixture-image",
        model: "fixture-v1",
        assets: [],
        cost: { basis: "unknown" },
      };
    }),
  );
  const job = await generateThumbnails(
    { source: f.source, aspect: "square", headline: "Fence me" },
    f.deps,
  );
  id = job.id;
  await f.execute(job);
  expect(listThumbnails(f.source, f.deps)).toHaveLength(0);
  expect(f.queue.get(id)!.owner).toBe("replacement");
  const reservation = f.store.list<any>("ai-reservation")[0]!.value;
  expect(reservation.state).toBe("settled");
  expect(reservation.cost.basis).toBe("unknown");
}, 90_000);
it("automatic mode requires a trusted creator policy and a new explicit request ID allows regeneration", async () => {
  const f = await fixture();
  await expect(
    generateThumbnails(
      {
        source: f.source,
        aspect: "square",
        headline: "Automatic",
        mode: "automatic",
      },
      f.deps,
    ),
  ).rejects.toThrow(/creator policy/i);
  const input = {
    source: f.source,
    aspect: "square" as const,
    headline: "Same design",
  };
  const first = await generateThumbnails(input, f.deps);
  const duplicate = await generateThumbnails(input, f.deps);
  expect(duplicate.id).toBe(first.id);
  const regenerated = await generateThumbnails(
    { ...input, requestId: "explicit-new-version" },
    f.deps,
  );
  expect(regenerated.id).not.toBe(first.id);
});
it("project frame selection resolves exact render revision and maps to clean original footage", async () => {
  const f = await fixture();
  const asset = {
    id: "video",
    kind: "video",
    location: path.join(f.root, "clip.mp4"),
    checksum: f.source.renderChecksum,
    status: "ready",
    original: { sourceOffsetUs: 9_000_000 },
  };
  f.store.put("assets", "video", asset);
  const project = {
    id: "project",
    schemaVersion: 1,
    revision: 2,
    canvas: { width: 320, height: 180 },
    fps: { numerator: 6, denominator: 1 },
    tracks: [{ id: "main", kind: "video" }],
    items: [
      {
        id: "clip",
        trackId: "main",
        assetId: "video",
        startFrame: 0,
        durationFrames: 6,
        sourceInUs: 500_000,
        sourceOutUs: 1_500_000,
        speed: 1,
      },
    ],
    captionCues: [],
    thumbnailIds: [],
    sourceMappings: [
      {
        itemId: "clip",
        assetId: "video",
        sourceInUs: 500_000,
        sourceOutUs: 1_500_000,
      },
    ],
  };
  f.store.put("projects", "project", project, 2);
  f.store.put("project-history", "project:2", project);
  const renderPath = path.join(f.root, "project-render.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "0.5",
    "-i",
    path.join(f.root, "clip.mp4"),
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    renderPath,
  ]);
  const renderChecksum = await checksum(renderPath);
  f.store.put("renders", "render", {
    id: "render",
    projectId: "project",
    revision: 2,
    checksum: renderChecksum,
    path: renderPath,
    probe: {
      durationUs: 1_000_000,
      width: 320,
      height: 180,
      fps: { numerator: 6, denominator: 1 },
      hasAudio: false,
    },
    renderer: "fixture",
    rendererVersion: "fixture",
    reviewIds: [],
  });
  const source = {
    kind: "project" as const,
    projectId: "project",
    revision: 2,
    renderId: "render",
    renderChecksum,
  };
  const job = await generateThumbnails(
    {
      source,
      aspect: "square",
      headline: "Clean selection",
      action: "frames",
      frameTimeUs: 333_333,
    },
    f.deps,
  );
  expect((await f.execute(job)).status).toBe("complete");
  const frame = f.store.list<any>("thumbnail-frames")[0]!.value;
  expect(frame.frameKind).toBe("clean");
  expect(frame.assetId).toBe("video");
  expect(frame.sourceUs).toBe(9_833_333);
  expect(frame.sourceRevision).toBe(2);
  const expected = path.join(f.root, "original-frame-5.jpg");
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    asset.location,
    "-vf",
    "select=eq(n\\,5)",
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuvj420p",
    "-q:v",
    "2",
    "-y",
    expected,
  ]);
  expect(frame.checksum).toBe(await checksum(expected));
  const finished = await generateThumbnails(
    {
      source,
      aspect: "square",
      headline: "Finished selection",
      action: "frames",
      frameTimeUs: 333_333,
      frameKind: "finished",
    },
    f.deps,
  );
  expect((await f.execute(finished)).status).toBe("complete");
  const finishedFrame = f.store
    .list<any>("thumbnail-frames")
    .map((r) => r.value)
    .find((f) => f.frameKind === "finished")!;
  expect(finishedFrame.renderUs).toBe(333_333);
  expect(finishedFrame.sourceUs).toBe(9_833_333);
  expect(finishedFrame.checksum).not.toBe(frame.checksum);
  await expect(
    generateThumbnails(
      {
        source: { ...source, revision: 3 },
        aspect: "square",
        headline: "Wrong revision",
      },
      f.deps,
    ),
  ).rejects.toThrow(/revision/i);
}, 90_000);
it("the production image transport uploads only selected frame bytes and returns usage-priced PNG assets", async () => {
  const f = await fixture();
  const framePath = path.join(f.root, "frame.jpg"),
    outputPng = path.join(f.root, "result.png");
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    path.join(f.root, "clip.mp4"),
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuvj420p",
    "-y",
    framePath,
  ]);
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=blue:size=640x360",
    "-frames:v",
    "1",
    "-y",
    outputPng,
  ]);
  const { createOpenAiImageProvider } =
    await import("../src/thumbnails/provider");
  const { readFile } = await import("node:fs/promises");
  const png = await readFile(outputPng);
  let calls = 0;
  const adapter = createOpenAiImageProvider(
    {
      apiKey: "test-credential",
      model: "gpt-image-2.5-sunburst-2026-09-08",
      estimatedCallUsd: 0.2,
    },
    async (url, options) => {
      calls++;
      expect(url).toBe("https://api.openai.com/v1/images/edits");
      const form = options!.body as FormData;
      expect(form.get("model")).toBe("gpt-image-2.5-sunburst-2026-09-08");
      expect(form.getAll("image[]")).toHaveLength(1);
      expect(
        Buffer.from(await (form.get("image[]") as Blob).arrayBuffer()),
      ).toEqual(await readFile(framePath));
      expect(form.has("transcript")).toBe(false);
      return new Response(
        JSON.stringify({
          data: [{ b64_json: png.toString("base64") }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { text_tokens: 20, image_tokens: 80 },
          },
        }),
        { status: 200 },
      );
    },
  );
  const frame = {
    id: "selected",
    path: framePath,
    checksum: await checksum(framePath),
    assetId: "video",
    sourceUs: 0,
    renderUs: 0,
    sourceRevision: 4,
    renderChecksum: f.source.renderChecksum,
    frameKind: "finished" as const,
    quality: { status: "usable" as const, score: 1, sharpness: 1, exposure: 1 },
  };
  const { buildThumbnailBrief } = await import("../src/thumbnails/brief");
  const brief = buildThumbnailBrief({
    headline: "Actual footage",
    aspect: "square",
    variant: 0,
    frames: [frame],
  });
  const result = await adapter.generate(
    {
      frames: [frame],
      brief,
      outputDirectory: path.join(f.root, "mock-provider"),
    },
    new AbortController().signal,
  );
  expect(calls).toBe(1);
  expect(result.cost.basis).toBe("estimated");
  expect(result.cost.value).toBeCloseTo(0.00224);
  expect(result.usage!.tokens).toBe(150);
  expect(await checksum(result.assets[0]!.path)).toBe(
    result.assets[0]!.checksum,
  );
  expect(adapter.capabilities.providerQuotaBound).toBe(false);
}, 30_000);

async function pngRgb(file: string, directory: string) {
  const { readFile } = await import("node:fs/promises");
  const raw = path.join(directory, `pixels-${path.basename(file)}.rgb`);
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "-y",
    raw,
  ]);
  return readFile(raw);
}
async function compositionFixture() {
  const f = await fixture();
  const { composeThumbnail, thumbnailLayers } =
    await import("../src/thumbnails/compose");
  const { buildThumbnailBrief } = await import("../src/thumbnails/brief");
  const framePath = path.join(f.root, "original.jpg");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:size=320x180",
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuvj420p",
    "-y",
    framePath,
  ]);
  const frame = {
    id: "original-frame",
    path: framePath,
    checksum: await checksum(framePath),
    assetId: "original",
    sourceUs: 0,
    renderUs: 0,
    sourceRevision: 4,
    renderChecksum: f.source.renderChecksum,
    frameKind: "finished" as const,
    quality: { status: "usable" as const, score: 1, sharpness: 1, exposure: 1 },
  };
  const brief = buildThumbnailBrief({
    headline: "Saved composition",
    aspect: "square",
    variant: 1,
    frames: [frame],
  });
  return { ...f, frame, brief, composeThumbnail, thumbnailLayers };
}
it("recomposes saved provider layers with the same source geometry and background pixels", async () => {
  const f = await compositionFixture();
  const backgroundPath = path.join(f.root, "generated.png");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=magenta:size=1080x1080",
    "-frames:v",
    "1",
    "-y",
    backgroundPath,
  ]);
  const first = await f.composeThumbnail(
    {
      brief: f.brief,
      frame: f.frame,
      directory: path.join(f.root, "first-compose"),
      background: {
        assetId: await checksum(backgroundPath),
        path: backgroundPath,
        checksum: await checksum(backgroundPath),
      },
    },
    new AbortController().signal,
  );
  const saved = structuredClone(first.layers);
  const background = saved.find((l) => l.id === "background")!;
  expect(background.kind).toBe("image");
  expect(background.assetId).toBe(await checksum(backgroundPath));
  saved.reverse();
  saved.find((l) => l.id === "headline")!.text = "Only the headline changed";
  const source = saved.find((l) => l.id === "source")!;
  const second = await f.composeThumbnail(
    {
      brief: f.brief,
      frame: f.frame,
      directory: path.join(f.root, "recompose"),
      background: {
        assetId: await checksum(backgroundPath),
        path: backgroundPath,
        checksum: await checksum(backgroundPath),
      },
      layers: saved,
    },
    new AbortController().signal,
  );
  expect(second.layers.find((l) => l.id === "source")).toEqual(source);
  const original = await pngRgb(first.versions[0]!.path, f.root),
    edited = await pngRgb(second.versions[0]!.path, f.root);
  const pixel = (pixels: Buffer, x: number, y: number) => [
    ...pixels.subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3),
  ];
  expect(pixel(edited, 10, 10)).toEqual(pixel(original, 10, 10));
  expect(pixel(edited, 10, 10)[0]).toBeGreaterThan(200);
  expect(pixel(edited, 10, 10)[2]).toBeGreaterThan(200);
  for (const [x, y] of [
    [source.x + 10, source.y + 10],
    [
      source.x + Math.floor(source.width / 2),
      source.y + Math.floor(source.height / 2),
    ],
  ])
    expect(pixel(edited, x!, y!)).toEqual(pixel(original, x!, y!));
  source.x = 540;
  source.width = 400;
  const moved = await f.composeThumbnail(
    {
      brief: f.brief,
      frame: f.frame,
      directory: path.join(f.root, "moved-source"),
      background: {
        assetId: background.assetId!,
        path: backgroundPath,
        checksum: background.assetId!,
      },
      layers: saved,
      textFree: true,
    },
    new AbortController().signal,
  );
  const movedPixels = await pngRgb(moved.versions[0]!.path, f.root);
  expect(pixel(movedPixels, 500, 80)[0]).toBeGreaterThan(200);
  expect(pixel(movedPixels, 500, 80)[2]).toBeGreaterThan(200);
  expect(pixel(movedPixels, 740, 540).every((channel) => channel < 50)).toBe(
    true,
  );
}, 90_000);
for (const headline of [
  "W".repeat(120),
  "WWWiiiiMMMM llllWWWW iiiiiiiii MMMMM WWWW iiiii WMWMWM iiiWWWW MMMMMM iiiiiWWWW iiiiWWWWMMMMM iiiiiiWWWMMMM",
]) {
  it(`fits actual glyph bounds and persists typography for ${headline.startsWith("WWWi") ? "mixed-width" : "wide"} headlines`, async () => {
    const f = await compositionFixture();
    const layers = f
      .thumbnailLayers({ ...f.brief, headline }, f.frame)
      .filter((l) => l.id !== "accent");
    layers.find((l) => l.id === "background")!.color = "000000";
    const text = layers.find((l) => l.id === "headline")!;
    text.color = "ffffff";
    const composed = await f.composeThumbnail(
      {
        brief: { ...f.brief, headline },
        frame: f.frame,
        directory: path.join(f.root, "glyph-fit"),
        layers,
      },
      new AbortController().signal,
    );
    const pixels = await pngRgb(composed.versions[0]!.path, f.root);
    let minX = 1080,
      minY = 1080,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < 1080; y++)
      for (let x = 0; x < 1080; x++) {
        const offset = (y * 1080 + x) * 3;
        if (
          pixels[offset]! > 80 &&
          pixels[offset + 1]! > 80 &&
          pixels[offset + 2]! > 80
        ) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    expect(maxX).toBeGreaterThan(minX);
    expect(minX).toBeGreaterThanOrEqual(text.x);
    expect(maxX).toBeLessThan(text.x + text.width);
    expect(minY).toBeGreaterThanOrEqual(text.y);
    expect(maxY).toBeLessThan(text.y + text.height);
    const resolved = composed.layers.find((l) => l.id === "headline")!;
    expect(resolved.fontSize).toBeLessThan(text.fontSize!);
    expect(resolved.fontFamily).toBeTruthy();
    expect(resolved.textLayout!.fontSize).toBe(resolved.fontSize);
    expect(resolved.textLayout!.fontFamily).toBe(resolved.fontFamily);
    expect(resolved.textLayout!.lines.length).toBeGreaterThan(1);
    expect(resolved.textLayout!.width).toBeLessThanOrEqual(resolved.width);
    expect(resolved.textLayout!.height).toBeLessThanOrEqual(resolved.height);
    const roundtrip = await f.composeThumbnail(
      {
        brief: f.brief,
        frame: f.frame,
        directory: path.join(f.root, "glyph-roundtrip"),
        layers: composed.layers,
      },
      new AbortController().signal,
    );
    expect(roundtrip.layers).toEqual(composed.layers);
    expect(roundtrip.versions[0]!.checksum).toBe(
      composed.versions[0]!.checksum,
    );
  }, 90_000);
}

it("rejects mismatched source and saved background identities before recomposition", async () => {
  const f = await compositionFixture();
  const layers = f.thumbnailLayers(f.brief, f.frame);
  const input = {
    brief: f.brief,
    frame: f.frame,
    directory: path.join(f.root, "reject-assets"),
    layers,
  };
  layers.find((layer) => layer.id === "source")!.assetId = "another-frame";
  await expect(
    f.composeThumbnail(input, new AbortController().signal),
  ).rejects.toThrow(/layers/);
  layers.find((layer) => layer.id === "source")!.assetId = f.frame.id;
  await expect(
    f.composeThumbnail(
      { ...input, frame: { ...f.frame, checksum: "wrong" } },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/Source frame bytes/);
  const background = layers.find((layer) => layer.id === "background")!;
  background.kind = "image";
  background.assetId = "another-background";
  await expect(
    f.composeThumbnail(input, new AbortController().signal),
  ).rejects.toThrow(/matching background asset/);
  const asset = {
    assetId: f.frame.checksum,
    path: f.frame.path,
    checksum: f.frame.checksum,
  };
  await expect(
    f.composeThumbnail(
      { ...input, background: asset },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/matching background asset/);
  background.assetId = asset.assetId;
  await expect(
    f.composeThumbnail(
      { ...input, background: { ...asset, checksum: "wrong" } },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/Background asset identity/);
}, 30_000);

it("recomposes edited position, font and color, and allows text-free output", async () => {
  const f = await compositionFixture();
  const layers = f
    .thumbnailLayers({ ...f.brief, headline: "Editable" }, f.frame)
    .filter((layer) => layer.id !== "accent");
  layers.find((layer) => layer.id === "background")!.color = "000000";
  const first = await f.composeThumbnail(
    {
      brief: f.brief,
      frame: f.frame,
      directory: path.join(f.root, "editable-first"),
      layers,
    },
    new AbortController().signal,
  );
  const edited = structuredClone(first.layers);
  const source = edited.find((layer) => layer.id === "source")!;
  source.x = 540;
  source.width = 400;
  const text = edited.find((layer) => layer.id === "headline")!;
  text.x = 101;
  text.y = 151;
  text.fontFamily = text.fontFamily!.replace(" Bold", "");
  text.color = "00ff00";
  const second = await f.composeThumbnail(
    {
      brief: f.brief,
      frame: f.frame,
      directory: path.join(f.root, "editable-second"),
      layers: edited,
    },
    new AbortController().signal,
  );
  expect(second.layers.find((layer) => layer.id === "source")).toEqual(source);
  const resolved = second.layers.find((layer) => layer.id === "headline")!;
  expect(resolved.fontFamily).toBe(text.fontFamily);
  expect(resolved.textLayout!.fontChecksum).not.toBe(
    first.layers.find((layer) => layer.id === "headline")!.textLayout!
      .fontChecksum,
  );
  const pixels = await pngRgb(second.versions[0]!.path, f.root);
  let greenPixels = 0;
  for (let y = 0; y < 1080; y++)
    for (let x = 0; x < 1080; x++) {
      const offset = (y * 1080 + x) * 3;
      if (
        pixels[offset + 1]! > 80 &&
        pixels[offset]! < 40 &&
        pixels[offset + 2]! < 40
      ) {
        greenPixels++;
        expect(x).toBeGreaterThanOrEqual(text.x);
        expect(x).toBeLessThan(text.x + text.width);
        expect(y).toBeGreaterThanOrEqual(text.y);
        expect(y).toBeLessThan(text.y + text.height);
      }
    }
  expect(greenPixels).toBeGreaterThan(100);
  // A text-free render does not require the saved font to remain installed.
  text.fontFamily = "missing-font";
  const clean = await f.composeThumbnail(
    {
      brief: f.brief,
      frame: f.frame,
      directory: path.join(f.root, "editable-clean"),
      layers: edited,
      textFree: true,
    },
    new AbortController().signal,
  );
  expect(clean.layers.find((layer) => layer.id === "source")).toEqual(source);
  const cleanPixels = await pngRgb(clean.versions[0]!.path, f.root);
  expect(Math.max(...cleanPixels.subarray(0, 100))).toBeLessThan(20);
  expect(cleanPixels.every((value) => value < 20)).toBe(true);
}, 90_000);
