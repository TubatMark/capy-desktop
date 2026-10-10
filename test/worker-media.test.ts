import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const env = vi.hoisted(() => {
  const fs = require("node:fs"),
    os = require("node:os"),
    p = require("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-media-recovery-"));
  process.env.CAPY_DATA_DIR = p.join(root, "data");
  process.env.CAPY_OUTPUT = p.join(root, "out");
  return { root };
});
const stageMeta = vi.fn(),
  stageWords = vi.fn(),
  stagePick = vi.fn(),
  stageSegment = vi.fn(),
  stageRender = vi.fn(),
  reviewPicks = vi.fn();
vi.mock("../src/pipeline", async (original) => ({
  ...(await original<typeof import("../src/pipeline")>()),
  stageMeta: (...args: unknown[]) => stageMeta(...args),
  stageWords: (...args: unknown[]) => stageWords(...args),
  stagePick: (...args: unknown[]) => stagePick(...args),
  stageSegment: (...args: unknown[]) => stageSegment(...args),
  stageRender: (...args: unknown[]) => stageRender(...args),
  thumbCandidates: async () => [],
}));
vi.mock("../src/review", async (original) => ({
  ...(await original<typeof import("../src/review")>()),
  reviewPicks: (...args: unknown[]) => reviewPicks(...args),
}));
vi.mock("../src/agents", async (original) => ({
  ...(await original<typeof import("../src/agents")>()),
  askAgent: async () => {
    throw Error("Fixture must not invoke a provider");
  },
}));
import { runtimeStore } from "../server/db/runtime";
import { workQueue } from "../server/worker/api";
import { registerMediaWorkers } from "../server/worker/media";
import { stagesFor } from "../server/worker/registry";
import { runJob } from "../server/worker/runner";
import { jobs } from "../server/jobs";
import { DEFAULT_SETTINGS, type JobState } from "../lib/types";
const out = process.env.CAPY_OUTPUT!;
registerMediaWorkers();
function setup(id: string) {
  const dir = `fixture-${id}`;
  const meta = {
    id,
    title: "Fixture",
    duration: 120,
    language: "en",
    url: `https://www.youtube.com/watch?v=${id}`,
  };
  const words = Array.from({ length: 50 }, (_, i) => ({
    text: "word",
    start: i,
    end: i + 0.5,
  }));
  mkdirSync(path.join(out, dir, "work"), { recursive: true });
  writeFileSync(path.join(out, dir, "meta.json"), JSON.stringify(meta));
  writeFileSync(path.join(out, dir, "words.json"), JSON.stringify(words));
  const job: JobState = {
    id,
    videoId: id,
    url: meta.url,
    title: meta.title,
    dir,
    duration: 120,
    language: "en",
    sourceLang: "en",
    status: "queued",
    stage: "meta",
    stageStartedAt: 0,
    createdAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS, audience: "original", autoPost: false },
    clips: [],
    log: [],
    estimate: { progress: 0, totalRemaining: 0, stageRemaining: 0 },
  };
  runtimeStore().put("legacy-jobs", id, job);
  for (const fn of [
    stageMeta,
    stageWords,
    stagePick,
    stageSegment,
    stageRender,
  ])
    fn.mockReset();
  reviewPicks.mockReset();
  reviewPicks.mockResolvedValue([
    { n: 1, verdict: "pass", problem: "", hook: "" },
  ]);
  stageMeta.mockImplementation(async (_url, root) => {
    const target = path.join(root, dir);
    mkdirSync(path.join(target, "work"), { recursive: true });
    writeFileSync(path.join(target, "meta.json"), JSON.stringify(meta));
    return { meta, jobDir: target, cached: true };
  });
  stageWords.mockImplementation(async (_u, target) => {
    writeFileSync(path.join(target, "words.json"), JSON.stringify(words));
    return { words, source: "captions" };
  });
  stagePick.mockResolvedValue({
    clips: [
      {
        start: 10,
        end: 30,
        title: "Clip",
        hook: "",
        reason: "fixture",
        score: 9,
      },
    ],
    raw: {},
  });
  stageSegment.mockImplementation(async (_u, target) => {
    const file = path.join(target, "work", "01.src.mp4"),
      thumb = path.join(target, "work", "01.jpg");
    writeFileSync(file, "complete-source");
    writeFileSync(thumb, "jpg");
    return { file, thumb, start: 0, end: 45 };
  });
  stageRender.mockImplementation(async (target) => {
    const file = path.join(target, "01-clip.mp4");
    writeFileSync(file, "complete-render");
    return file;
  });
  return { job, dir };
}
async function drain() {
  const q = workQueue();
  const lease = (await q.claim("fixture-worker"))!;
  await runJob(lease, new AbortController().signal, {
    queue: q,
    stages: stagesFor(lease),
    artifactRoot: out,
  });
  return q.get(lease.id)!;
}
describe("actual media worker adapters", () => {
  it("request enqueue persists before metadata and runs no provider in the request process", async () => {
    const { job } = setup("fixture0001");
    await jobs().repick(job.id);
    expect(stageMeta).not.toHaveBeenCalled();
    expect(runtimeStore().get("legacy-jobs", job.id)).toBeDefined();
    for (const task of workQueue()
      .list()
      .filter((x) => x.payload.jobId === job.id))
      await workQueue().cancel(task.id);
  });
  it("transcript survives failed download and retry skips completed expensive stages", async () => {
    const { job, dir } = setup("fixture0002");
    await jobs().repick(job.id);
    stageSegment.mockRejectedValueOnce(Error("download interrupted"));
    let task = await drain();
    expect(task.status).toBe("retryable");
    expect(task.checkpoint.mediaComplete).toEqual(["meta", "captions", "pick"]);
    expect(readFileSync(path.join(out, dir, "words.json"), "utf8")).toContain(
      "word",
    );
    runtimeStore().put("work", task.id, { ...task, retryAt: 0 });
    task = await drain();
    expect(task.status).toBe("complete");
    expect(stageMeta).toHaveBeenCalledTimes(1);
    expect(stageWords).toHaveBeenCalledTimes(1);
    expect(stagePick).toHaveBeenCalledTimes(1);
    expect(stageSegment).toHaveBeenCalledTimes(2);
    expect(
      readFileSync(path.join(out, dir, "work", "01.src.mp4"), "utf8"),
    ).toBe("complete-source");
  });
  it("failed review remains unselected and survives strict durable reload", async () => {
    const { job } = setup("fixture0004");
    reviewPicks.mockRejectedValue(Error("review unavailable"));
    await jobs().repick(job.id);
    const task = await drain();
    expect(task.status).toBe("complete");
    const stored = runtimeStore().get<JobState>("legacy-jobs", job.id)!.value;
    expect(stored.clips[0]?.selected).toBe(false);
    expect(stored.clips[0]?.review?.verdict).toBe("needs_review");
    expect(jobs().get(job.id)?.clips[0]?.review?.verdict).toBe("needs_review");
  });
  it("interrupted render preserves completed source and retries only render", async () => {
    const { job, dir } = setup("fixture0003");
    const stored = runtimeStore().get<JobState>("legacy-jobs", job.id)!;
    stored.value.status = "ready";
    stored.value.stage = "done";
    stored.value.clips = [
      {
        n: 1,
        start: 10,
        end: 30,
        title: "Clip",
        hook: "",
        reason: "fixture",
        score: 9,
        selected: true,
        render: { status: "none" },
        segment: {
          status: "done",
          start: 0,
          end: 45,
          url: `/api/media/${dir}/work/01.src.mp4`,
        },
      },
    ];
    runtimeStore().put("legacy-jobs", job.id, stored.value);
    writeFileSync(path.join(out, dir, "work", "01.src.mp4"), "original-source");
    await jobs().render(job.id, [1]);
    stageRender.mockRejectedValueOnce(Error("render interrupted"));
    let task = await drain();
    expect(task.status).toBe("retryable");
    const rejections: unknown[] = [];
    const observe = (error: unknown) => {
      rejections.push(error);
    };
    process.on("unhandledRejection", observe);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", observe);
    }
    expect(
      readFileSync(path.join(out, dir, "work", "01.src.mp4"), "utf8"),
    ).toBe("original-source");
    runtimeStore().put("work", task.id, { ...task, retryAt: 0 });
    task = await drain();
    expect(task.status).toBe("complete");
    expect(stageRender).toHaveBeenCalledTimes(2);
    expect(stageSegment).not.toHaveBeenCalled();
    expect(readFileSync(path.join(out, dir, "01-clip.mp4"), "utf8")).toBe(
      "complete-render",
    );
  });
});
