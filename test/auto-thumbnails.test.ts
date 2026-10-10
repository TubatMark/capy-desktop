import { afterAll, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

// OUTPUT_ROOT and the data folder resolve at import: point both at a temp folder first
const env = vi.hoisted(() => {
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const p = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-auto-thumbs-"));
  process.env.CAPY_OUTPUT = p.join(root, "out");
  process.env.CAPY_DATA_DIR = p.join(root, "data");
  return { root };
});

import { run } from "../src/exec";
import { claudeImagePrompt } from "../src/agents";
import { checksum } from "../server/studio/assets";
import { DEFAULT_AI_ROUTING, resolveAiTask } from "../lib/ai-policy";
import { DEFAULT_CREATOR_POLICY } from "../lib/creator-policy";
import type { FrameCandidate } from "../lib/thumbnails";
import type { QueueEntry } from "../lib/types";
import { runtimeStore } from "../server/db/runtime";
import { WorkQueue } from "../server/worker/leases";
import { runJob } from "../server/worker/runner";
import { OUTPUT_ROOT } from "../server/paths";
import { routeAiTask } from "../server/ai-router";
import {
  pickThumbnail,
  headlineIsGrounded,
  type VisionAsk,
} from "../server/thumbnail-pick";
import {
  automaticThumbnailsAllowed,
  generateThumbnails,
  listThumbnails,
  thumbnailDependencies,
  thumbnailStages,
  type ThumbnailDependencies,
} from "../server/thumbnails";
import { switchQueueThumbnail } from "../server/thumbnail-studio";
import {
  automationPublicationFiles,
  creatorPolicy,
  getAutomationPublicationChecks,
  saveCreatorPolicy,
  unsavedCreatorPolicy,
} from "../server/automation-policy";
import { decide, hashFile } from "../server/publication-policy";
import { publicQueueEntry } from "../server/queue";
import { addChannel, watch } from "../server/watch";
import { publicationFixture } from "./publication-fixtures";

afterAll(() => rmSync(env.root, { recursive: true, force: true }));

async function frames(count: number): Promise<FrameCandidate[]> {
  const dir = path.join(OUTPUT_ROOT, "pick-frames");
  mkdirSync(dir, { recursive: true });
  const out: FrameCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `f${i}.jpg`);
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=1080x1920:rate=1:duration=1`,
      "-frames:v",
      "1",
      "-y",
      file,
    ]);
    out.push({
      id: `frame-${i}`,
      path: file,
      checksum: await checksum(file),
      assetId: "source",
      sourceUs: i * 1000,
      renderUs: i * 1000,
      sourceRevision: 1,
      renderChecksum: "0".repeat(64),
      frameKind: "finished",
      quality: {
        status: "usable",
        score: i, // ascending, so the local ranking puts the last frame first
        sharpness: i,
        exposure: 1,
      },
    });
  }
  return out;
}

it("AI pick falls back to the local ranking and the clip's hook when the AI is unavailable", async () => {
  const candidates = await frames(3);
  const pick = await pickThumbnail(
    {
      frames: candidates,
      hook: "The trick that saved the match",
      fallbackHeadline: "The trick that saved the match",
      directory: path.join(OUTPUT_ROOT, "pick-a"),
    },
    async () => {
      throw Object.assign(Error("Daily AI limit reached"), {
        code: "AI_BUDGET_EXHAUSTED",
      });
    },
  );
  expect(pick.by).toBe("heuristic");
  expect(pick.frames.map((f) => f.id)).toEqual([
    "frame-2",
    "frame-1",
    "frame-0",
  ]);
  expect(pick.headline).toBe("The trick that saved the match");
  expect(pick.layout).toBeUndefined();
  expect(pick.reason).toMatch(/Daily AI limit reached/);
});

it("AI pick sends small labelled JPEG frames and uses the ranked frame, headline and layout", async () => {
  const candidates = await frames(10);
  let sent: Parameters<VisionAsk>[1] | undefined;
  const pick = await pickThumbnail(
    {
      frames: candidates,
      title: "Keeper saves a penalty in the last minute",
      hook: "He guessed right",
      transcript: "and he dives left and saves it, unbelievable",
      fallbackHeadline: "He guessed right",
      directory: path.join(OUTPUT_ROOT, "pick-b"),
    },
    async (_prompt, o) => {
      sent = o;
      return {
        data: {
          ranking: ["C", "A"],
          headline: "Last-minute penalty save",
          layout: "editorial",
        },
      };
    },
  );
  // only the top eight candidates are shown, each downscaled and labelled
  expect(sent!.images).toHaveLength(8);
  expect(sent!.images.map((i) => i.label)).toEqual(
    "ABCDEFGH".split("").map((l) => `Frame ${l}`),
  );
  for (const image of sent!.images) {
    const bytes = Buffer.from(image.data, "base64");
    expect(image.mediaType).toBe("image/jpeg");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(bytes.length).toBeLessThan(150_000);
  }
  // A = frame-9 (best local score), C = frame-7
  expect(pick.frames.slice(0, 3).map((f) => f.id)).toEqual([
    "frame-7",
    "frame-9",
    "frame-8",
  ]);
  expect(pick.frames).toHaveLength(10);
  expect(pick).toMatchObject({
    by: "ai",
    headline: "Last-minute penalty save",
    layout: "editorial",
  });
});

it("AI headlines with invented numbers or too many words are replaced by the hook", async () => {
  expect(headlineIsGrounded("Won 3-1 in 90 minutes", "won 3-1 after 90")).toBe(
    true,
  );
  expect(headlineIsGrounded("Saved 5 penalties", "he saved a penalty")).toBe(
    false,
  );
  const candidates = await frames(2);
  for (const headline of [
    "He saved 5 penalties",
    "this headline has far too many words in it",
  ]) {
    const pick = await pickThumbnail(
      {
        frames: candidates,
        hook: "He guessed right",
        transcript: "he dives left and saves it",
        fallbackHeadline: "He guessed right",
        directory: path.join(OUTPUT_ROOT, "pick-c"),
      },
      async () => ({ data: { ranking: ["B"], headline, layout: "bold" } }),
    );
    expect(pick.by).toBe("ai");
    expect(pick.frames[0]!.id).toBe("frame-0");
    expect(pick.headline).toBe("He guessed right");
  }
});

it("Claude accepts image inputs for vision; text-only routes and other tasks do not", async () => {
  expect(resolveAiTask("vision", { agent: "claude" }).modality).toBe("image");
  expect(() => resolveAiTask("vision", { agent: "codex" })).toThrow(/image/);
  const message = claudeImagePrompt("Pick one", [
    { mediaType: "image/jpeg", data: "AAAA", label: "Frame A" },
  ]);
  const turns = [];
  for await (const m of message) turns.push(m);
  expect(turns).toEqual([
    {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "Pick one" },
          { type: "text", text: "Frame A" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
          },
        ],
      },
    },
  ]);
  const store = runtimeStore();
  const images = [{ mediaType: "image/jpeg" as const, data: "AAAA" }];
  const request = {
    agent: "claude" as const,
    prompt: "Pick one",
    system: "JSON only",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    images,
    context: { settings: DEFAULT_AI_ROUTING, jobId: "vision-route" },
  };
  await expect(
    routeAiTask({ ...request, task: "metadata" }, async () => {
      throw Error("must not be called");
    }, store),
  ).rejects.toThrow(/does not accept image inputs/);
  let received: unknown;
  const result = await routeAiTask(
    { ...request, task: "vision" },
    async (_agent, _prompt, o) => {
      received = o.images;
      return { data: { ok: true }, cost: { basis: "estimated", value: 0.001 } };
    },
    store,
  );
  expect(result.data).toEqual({ ok: true });
  expect(received).toEqual(images);
});

it("channels without saved options make thumbnails automatically; saved options keep their own setting", () => {
  watch().mutate((f) =>
    addChannel(
      f,
      {
        id: "auto-chan",
        name: "Auto",
        url: "https://youtube.com/channel/auto-chan/videos",
      },
      [],
      { now: new Date(1000) },
    ),
  );
  expect(DEFAULT_CREATOR_POLICY.thumbnailGeneration).toBe("manual");
  const channel = watch()
    .get()
    .channels.find((c) => c.id === "auto-chan")!;
  expect(unsavedCreatorPolicy(channel).thumbnailGeneration).toBe("automatic");
  expect(creatorPolicy("auto-chan").thumbnailGeneration).toBe("automatic");
  const store = runtimeStore();
  store.put("automation-jobs", "auto-chan-job", { channelId: "auto-chan" });
  const source = {
    kind: "legacy" as const,
    jobId: "auto-chan-job",
    clipN: 1,
    revision: 1,
    renderChecksum: "0".repeat(64),
  };
  expect(automaticThumbnailsAllowed(source, store)).toBe(true);
  expect(automaticThumbnailsAllowed({ ...source, jobId: "manual-job" }, store))
    .toBe(false);
  saveCreatorPolicy("auto-chan", { ...DEFAULT_CREATOR_POLICY });
  expect(creatorPolicy("auto-chan").thumbnailGeneration).toBe("manual");
  expect(automaticThumbnailsAllowed(source, store)).toBe(false);
});

it("automatic designs attach to the clip's YouTube post in review only, survive approval and switch from the Queue", async () => {
  const store = runtimeStore();
  publicationFixture();
  const file = path.join(OUTPUT_ROOT, "auto-clip.mp4");
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
  const p = saveCreatorPolicy("auto-attach", {
    ...DEFAULT_CREATOR_POLICY,
    thumbnailGeneration: "automatic",
    mode: "automatic_drafts",
    destinationAccountIds: ["fixture-account"],
    requireModelReview: false,
  });
  store.put("automation-jobs", "auto", {
    channelId: "auto-attach",
    recipeId: p.recipeId,
  });
  store.put("legacy-jobs", "auto", {
    id: "auto",
    clips: [
      {
        n: 1,
        start: 0,
        end: 2,
        title: "Keeper saves a penalty",
        hook: "He guessed right",
        render: { status: "done", file },
      },
    ],
  });
  const raw = path.join(OUTPUT_ROOT, "auto-clip.jpg");
  await run("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-y", raw]);
  const entry = (platform: QueueEntry["platform"], over: Partial<QueueEntry> = {}) =>
    ({
      key: `auto:1:${platform}`,
      jobId: "auto",
      n: 1,
      platform,
      status: "review",
      clipTitle: "Keeper saves a penalty",
      text: { title: "Keeper saves a penalty" },
      attempts: 0,
      history: [],
      createdAt: 1,
      updatedAt: 1,
      thumbUrl: "/api/media/auto-clip.jpg",
      publicationFiles: { file, thumbFile: raw },
      ...over,
    }) as QueueEntry;
  const scheduledPkg = decide(entry("youtube"), false, new Date()).publishPackage!;
  const untouched = [
    entry("tiktok"),
    entry("youtube", {
      key: "auto:1:youtube~0-10",
      status: "scheduled",
      slotAt: Date.now() + 3600_000,
      publishPackage: scheduledPkg,
    }),
    entry("youtube", { key: "auto:1:youtube~0-15", status: "posted" }),
  ];
  store.put("legacy-state", "queue", [entry("youtube"), ...untouched]);
  const source = {
    kind: "legacy" as const,
    jobId: "auto",
    clipN: 1,
    revision: store.get("legacy-jobs", "auto")!.revision,
    renderChecksum: await checksum(file),
  };
  let labels: string[] = [];
  const deps: ThumbnailDependencies = {
    ...thumbnailDependencies(),
    store,
    root: OUTPUT_ROOT,
    queue: new WorkQueue(store),
    provider: undefined,
    settings: { ...DEFAULT_AI_ROUTING },
    ask: async (_prompt, o) => {
      labels = o.images.map((i) => i.label!.replace("Frame ", ""));
      return {
        data: {
          ranking: [labels.at(-1)!],
          headline: "Penalty saved",
          layout: "minimal",
        },
      };
    },
  };
  expect(deps.allowAutomatic!(source)).toBe(true);
  const job = await generateThumbnails(
    {
      source,
      aspect: "portrait",
      headline: "He guessed right",
      mode: "automatic",
      allowCloud: false,
      clipContext: { title: "Keeper saves a penalty", hook: "He guessed right" },
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
  expect(done.checkpoint.attached).toEqual(["auto:1:youtube"]);
  const designs = done.checkpoint.designs as { id: string }[];
  const top = listThumbnails(source, deps).find((d) => d.id === designs[0]!.id)!;
  expect(top.layout).toBe("minimal");
  expect(top.pick?.by).toBe("ai");
  expect(top.layers.find((l) => l.kind === "text")?.text).toBe("Penalty saved");

  const queue = store.get<QueueEntry[]>("legacy-state", "queue")!.value;
  const attached = queue.find((e) => e.key === "auto:1:youtube")!;
  expect(attached.status).toBe("review");
  expect(attached.publicationDecision).toBeUndefined();
  expect(attached.publishPackage?.thumbnail?.designId).toBe(top.id);
  expect(attached.publicationFiles?.thumbFile).not.toBe(raw);
  expect(hashFile(attached.publicationFiles!.thumbFile)).toBe(
    attached.publishPackage!.thumbnail!.checksum,
  );
  expect(attached.history.at(-1)?.msg).toBe("AI thumbnail added");
  // scheduled, posted and non-YouTube posts are left exactly as they were
  expect(queue.filter((e) => e.key !== "auto:1:youtube")).toEqual(untouched);

  // the automated clip keeps its designed thumbnail through approval, even after a text edit
  expect(
    automationPublicationFiles(attached, attached.publicationFiles!).thumbFile,
  ).toBe(attached.publicationFiles!.thumbFile);
  const edited = { ...attached, text: { title: "Edited title" } };
  const approved = decide(edited, false, new Date());
  expect(approved.publishPackage!.packageHash).not.toBe(
    attached.publishPackage!.packageHash,
  );
  expect(approved.publishPackage!.thumbnail).toEqual(
    attached.publishPackage!.thumbnail,
  );
  expect(approved.publicationFiles!.thumbFile).toBe(
    attached.publicationFiles!.thumbFile,
  );
  expect(getAutomationPublicationChecks(approved).reasons).not.toContain(
    "Selected thumbnail revision, provenance or composition is stale or failed",
  );

  // the Queue sees the real thumbnail and can switch to another design
  const shown = publicQueueEntry(attached);
  expect(shown.thumbnailDesignId).toBe(top.id);
  expect(shown.thumbnailDesignUrl).toMatch(/^\/api\/media\/.+\.jpg$/);
  expect(shown.thumbUrl).toBe(shown.thumbnailDesignUrl);
  expect(shown.frameThumbUrl).toBe("/api/media/auto-clip.jpg");
  expect(shown.thumbnailOptions?.map((o) => o.designId).sort()).toEqual(
    designs.map((d) => d.id).sort(),
  );
  expect(shown.thumbnailOptions?.filter((o) => o.attached)).toHaveLength(1);
  expect(publicQueueEntry(untouched[0]!).thumbnailOptions).toBeUndefined();
  const other = designs[1]!.id;
  const switched = await switchQueueThumbnail("auto:1:youtube", other, deps);
  expect(switched.publishPackage?.thumbnail?.designId).toBe(other);
  expect(switched.status).toBe("review");
  expect(switched.history.at(-1)?.msg).toBe("Thumbnail changed");
  await expect(
    switchQueueThumbnail("auto:1:tiktok", other, deps),
  ).rejects.toThrow(/Only YouTube/);
  await expect(
    switchQueueThumbnail("auto:1:youtube~0-15", other, deps),
  ).rejects.toThrow(/can't change/);
}, 120_000);
