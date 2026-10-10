import { afterAll, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const env = vi.hoisted(() => {
  const fs = require("node:fs"),
    os = require("node:os"),
    p = require("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-render-proof-"));
  process.env.CAPY_OUTPUT = p.join(root, "output");
  process.env.CAPY_DATA_DIR = p.join(root, "data");
  process.env.CAPY_AI_ALLOW_CLOUD = "false";
  return { root };
});
vi.mock("../src/agents", async (orig) => ({
  ...(await orig<typeof import("../src/agents")>()),
  askAgent: async () => {
    throw Error("Provider forbidden in render-proof fixture");
  },
}));
vi.mock("../src/content-review", async (orig) => ({
  ...(await orig<typeof import("../src/content-review")>()),
  reviewContent: async () => {
    throw Error("Local fixture has no model review");
  },
}));
import { jobs } from "../server/jobs";
import { runtimeStore } from "../server/db/runtime";
import { workQueue } from "../server/worker/api";
import { withWork } from "../server/worker/context";
import { DEFAULT_SETTINGS, type JobState } from "../lib/types";
import { DEFAULT_CREATOR_POLICY } from "../lib/creator-policy";
import { saveCreatorPolicy } from "../server/automation-policy";
import {
  captureRenderInputs,
  getRenderProof,
  measureRenderedAttribution,
  recordSuccessfulRender,
} from "../server/render-attribution";
import { hashFile } from "../server/publication-policy";
import { run } from "../src/exec";
afterAll(() => rmSync(env.root, { recursive: true, force: true }));
it("real worker rendering captures admitted inputs and binds exact promoted media before automation is cleared", async () => {
  const store = runtimeStore(),
    dir = path.join(process.env.CAPY_OUTPUT!, "proof-job");
  mkdirSync(path.join(dir, "work"), { recursive: true });
  writeFileSync(path.join(dir, "words.json"), "[]");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=6:duration=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    path.join(dir, "segment.mp4"),
  ]);
  const policy = saveCreatorPolicy("proof-creator", {
    ...DEFAULT_CREATOR_POLICY,
    mode: "automatic_drafts",
  });
  const job: JobState = {
    id: "proof-job",
    dir: "proof-job",
    videoId: "proof-source",
    url: "https://example.invalid/owned-fixture",
    title: "Proof fixture",
    settings: { ...DEFAULT_SETTINGS, count: 3, autoPost: false },
    automation: {
      channelId: "proof-creator",
      channelName: "Proof creator",
      recipeId: policy.recipeId,
    },
    status: "ready",
    stage: "done",
    createdAt: Date.now(),
    stageStartedAt: Date.now(),
    estimate: { stageRemaining: 0, totalRemaining: 0, progress: 1 },
    log: [],
    clips: [
      {
        n: 1,
        start: 0,
        end: 1,
        title: "Proof fixture",
        hook: "",
        reason: "Owned fixture",
        score: 1,
        selected: false,
        publish: {
          ytTitle: "Local fixture",
          description: "",
          hashtags: [],
          edited: true,
        },
        render: { status: "queued" },
        segment: {
          start: 0,
          end: 1,
          url: "/api/media/proof-job/segment.mp4",
          status: "done",
        },
      },
    ],
  };
  store.put("legacy-jobs", job.id, job);
  store.put("automation-jobs", job.id, {
    channelId: "proof-creator",
    recipeId: policy.recipeId,
  });
  const queue = workQueue();
  await queue.enqueue({
    kind: "media",
    workKey: "proof-job-render",
    inputRevision: 1,
    payload: { jobId: job.id, operation: "render", args: [1] },
  });
  const lease = (await queue.claim("proof-worker"))!;
  const workspace = path.join(env.root, "generation");
  mkdirSync(workspace, { recursive: true });
  await withWork(
    { queue, lease, workspace, signal: new AbortController().signal },
    () => jobs().executeWork(lease),
  );
  const saved = store.get<JobState>("legacy-jobs", job.id)!.value,
    clip = saved.clips[0]!;
  expect(clip.render.status).toBe("done");
  expect(saved.automation).toBeUndefined();
  expect(clip.render.file!.startsWith(process.env.CAPY_OUTPUT!)).toBe(true);
  const actual = await measureRenderedAttribution(clip.render.file!),
    proof = getRenderProof(job.id, 1, actual.checksum)!;
  expect(proof).toBeDefined();
  expect(proof.checksum).toBe(hashFile(clip.render.file!));
  expect(proof.durationUs).toBe(actual.durationUs);
  expect(proof.input.recipe).toMatchObject({
    state: "attributed",
    recipeId: policy.recipeId,
  });
  expect(proof.input.worker).toEqual({
    id: lease.id,
    generation: lease.generation,
  });
  expect(proof.input.sourceVideoId).toBe("proof-source");
  expect(proof.input.settings.style).toBe("bold");
  expect(actual.durationUs).toBeGreaterThan(0);
}, 60000);
it("a replaced worker generation cannot finalize even valid actual media", async () => {
  const queue = workQueue();
  await queue.enqueue({
    kind: "media",
    workKey: "stale-proof",
    inputRevision: 1,
    payload: { jobId: "stale" },
  });
  const lease = (await queue.claim("stale-worker"))!;
  const job = {
    id: "stale",
    videoId: "source",
    settings: { ...DEFAULT_SETTINGS },
  } as JobState;
  const input = await withWork(
    { queue, lease, workspace: env.root, signal: new AbortController().signal },
    async () =>
      captureRenderInputs(job, {
        n: 1,
        start: 0,
        end: 1,
      } as JobState["clips"][number]),
  );
  const work = queue.get(lease.id)!;
  runtimeStore().put("work", lease.id, {
    ...work,
    generation: work.generation + 1,
  });
  const file = path.join(process.env.CAPY_OUTPUT!, "proof-job", "segment.mp4"),
    actual = await measureRenderedAttribution(file);
  await expect(
    withWork(
      {
        queue,
        lease,
        workspace: env.root,
        signal: new AbortController().signal,
      },
      async () => recordSuccessfulRender(input, file, actual),
    ),
  ).rejects.toThrow(/lease|replaced/i);
  expect(getRenderProof("stale", 1, actual.checksum)).toBeUndefined();
});
