import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// OUTPUT_ROOT is resolved when server/paths loads: point it at a temp folder first
const env = vi.hoisted(() => {
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const p = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-jobs-"));
  process.env.CAPY_OUTPUT = p.join(root, "out");
  process.env.CAPY_DATA_DIR = p.join(root, "data");
  return { root };
});

// no test may reach a real AI
vi.mock("../src/agents", async (orig) => ({ ...(await orig<typeof import("../src/agents")>()), askAgent: async () => { throw new Error("askAgent called in a test"); } }));
const pickClips = vi.fn();
vi.mock("../src/pick", async (orig) => ({ ...(await orig<typeof import("../src/pick")>()), pickClips: (...a: unknown[]) => pickClips(...a) }));
vi.mock("../src/review", async (orig) => ({ ...(await orig<typeof import("../src/review")>()), reviewPicks: async () => [] }));
const translatePhrases = vi.fn();
vi.mock("../src/translate", async (orig) => ({ ...(await orig<typeof import("../src/translate")>()), translatePhrases: (...a: unknown[]) => translatePhrases(...a) }));
const reviewContent = vi.fn();
vi.mock("../src/content-review", async (orig) => ({ ...(await orig<typeof import("../src/content-review")>()), reviewContent: (...a: unknown[]) => reviewContent(...a) }));
vi.mock("../src/pipeline", async (orig) => ({
  ...(await orig<typeof import("../src/pipeline")>()),
  stageRender: async (jobDir: string, n: number) => {
    const f = path.join(jobDir, `0${n}-clip.mp4`);
    writeFileSync(f, "mp4");
    return f;
  },
  thumbCandidates: async () => [],
  stageSegment: async (_u: string, jobDir: string, n: number, c: { start: number; end: number }) => ({ start: c.start - 15, end: c.end + 15, file: path.join(jobDir, `seg${n}.mp4`), thumb: path.join(jobDir, `seg${n}.jpg`) }),
}));

import { jobs } from "../server/jobs";
import { watch } from "../server/watch";
import type { ClipState, JobState } from "../lib/types";

const OUT = process.env.CAPY_OUTPUT!;
// Portuguese words, one sentence every 5 seconds from 0 to 400s
const words = Array.from({ length: 80 }, (_, k) => [
  { text: "Olha", start: k * 5, end: k * 5 + 0.5 },
  { text: `isso${k}.`, start: k * 5 + 0.5, end: k * 5 + 1 },
]).flat();

function clip(n: number, start: number, end: number, extra: Partial<ClipState> = {}): ClipState {
  return { n, start, end, title: `t${n}`, hook: "h", reason: "r", score: 5, selected: true, render: { status: "none" }, segment: { start: start - 15, end: end + 15, url: `/api/media/x/seg${n}.mp4`, status: "done" }, ...extra };
}

let seq = 0;
async function seedJob(clips: ClipState[], extra: Partial<JobState> = {}): Promise<JobState> {
  const id = `vid${++seq}xxxxx`.slice(0, 11);
  const dir = `t-${id}`;
  mkdirSync(path.join(OUT, dir), { recursive: true });
  writeFileSync(path.join(OUT, dir, "words.json"), JSON.stringify(words));
  writeFileSync(path.join(OUT, dir, "meta.json"), JSON.stringify({ id, title: "T", duration: 400, url: "u", subtitles: [], autoCaptions: [] }));
  const job: JobState = {
    id, videoId: id, url: `https://www.youtube.com/watch?v=${id}`, title: "T", duration: 400, status: "ready", stage: "done", stageStartedAt: 0, createdAt: 0,
    settings: { count: 3, minSec: 20, maxSec: 60, layout: "center", style: "bold", captions: true, hook: true, maxRes: 1080, audience: "en-us" },
    estimate: { stageRemaining: 0, totalRemaining: 0, progress: 1 }, clips, log: [], dir, sourceLang: "pt-BR", ...extra,
  };
  writeFileSync(path.join(OUT, dir, "job.json"), JSON.stringify(job));
  const m = jobs();
  await m.init();
  m.jobs.set(id, job);
  return job;
}

const enFor = (phrases: { i: number; start: number; end: number }[]) => phrases.map((p) => ({ text: `EN${p.i}`, start: p.start, end: p.end }));

beforeEach(() => {
  reviewContent.mockReset();
  reviewContent.mockResolvedValue({ verdict: "ok", summary: "Fine", issues: [], at: 1 });
  pickClips.mockReset();
  translatePhrases.mockReset();
  translatePhrases.mockImplementation(async (ph: { i: number; start: number; end: number }[]) => enFor(ph));
});

describe("poster start-up", () => {
  it("loading the jobs starts the background poster (no instrumentation hook, which traced the whole project)", async () => {
    await jobs().init();
    expect(globalThis.__capyPoster?.timer).toBeDefined();
  });
});

describe("replaceClip", () => {
  it("refuses clips that are queued or stale (they have, or are about to have, a render)", async () => {
    for (const status of ["queued", "stale"] as const) {
      const job = await seedJob([clip(1, 100, 140, { render: { status } })]);
      await expect(jobs().replaceClip(job.id, 1, "x")).rejects.toMatchObject({ status: 409 });
      expect(pickClips).not.toHaveBeenCalled();
    }
  });
  it("re-checks the clip after the AI answers, so a render queued meanwhile isn't swapped out", async () => {
    const job = await seedJob([clip(1, 100, 140), clip(2, 200, 240)]);
    let answer!: (v: unknown) => void;
    pickClips.mockReturnValue(new Promise((r) => (answer = r)));
    const p = jobs().replaceClip(job.id, 1, "boring");
    await vi.waitFor(() => expect(pickClips).toHaveBeenCalled());
    job.clips[0]!.render = { status: "queued" };
    answer({ clips: [{ start: 300, end: 340, title: "new", hook: "h", reason: "r", score: 8 }], raw: {}, costUsd: 0, durationMs: 1 });
    await expect(p).rejects.toMatchObject({ status: 409 });
    expect(job.clips[0]!.start).toBe(100);
  });
});

describe("caption words for render", () => {
  it("translates the part of a trimmed clip that isn't translated yet before rendering", async () => {
    const job = await seedJob([clip(1, 150, 175, { captionsTranslated: true })], { translated: [{ start: 100, end: 160 }] });
    writeFileSync(path.join(OUT, job.dir, "words.en.json"), JSON.stringify(words.filter((w) => w.start >= 100 && w.start < 160).map((w) => ({ ...w, text: "OLD" }))));
    const got = await jobs().captionWordsFor(job, job.clips[0]!);
    expect(translatePhrases).toHaveBeenCalledTimes(1);
    const inClip = got.filter((w) => w.start >= 150 && w.start < 175);
    expect(inClip.some((w) => w.start >= 160)).toBe(true);
    expect(inClip.every((w) => w.text !== "Olha")).toBe(true); // never the Portuguese originals
  });
  it("translates a clip whose translation never ran (cancelled) instead of rendering Portuguese", async () => {
    const job = await seedJob([clip(1, 50, 80)]);
    const got = await jobs().captionWordsFor(job, job.clips[0]!);
    expect(translatePhrases).toHaveBeenCalledTimes(1);
    expect(got.filter((w) => w.start >= 50 && w.start < 80).every((w) => w.text.startsWith("EN"))).toBe(true);
  });
  it("uses the original words when the audience is original", async () => {
    const job = await seedJob([clip(1, 50, 80)], { settings: { count: 3, minSec: 20, maxSec: 60, layout: "center", style: "bold", captions: true, hook: true, maxRes: 1080, audience: "original" } });
    const got = await jobs().captionWordsFor(job, job.clips[0]!);
    expect(translatePhrases).not.toHaveBeenCalled();
    expect(got.some((w) => w.text === "Olha")).toBe(true);
  });
});

describe("parallel translations", () => {
  it("keeps both clips' English words when two translate at once with nothing cached", async () => {
    const job = await seedJob([clip(1, 30, 60), clip(2, 300, 330)]);
    await Promise.all([jobs().translateClip(job.id, 1), jobs().translateClip(job.id, 2)]);
    const saved: { start: number }[] = JSON.parse(readFileSync(path.join(OUT, job.dir, "words.en.json"), "utf8"));
    expect(saved.some((w) => w.start >= 30 && w.start < 60)).toBe(true);
    expect(saved.some((w) => w.start >= 300 && w.start < 330)).toBe(true);
  });
});

void env;
void mkdtempSync;
void tmpdir;

describe("automation jobs", () => {
  const original = { count: 3, minSec: 20, maxSec: 60, layout: "center" as const, style: "bold" as const, captions: true, hook: true, maxRes: 1080, audience: "original" as const };
  const watching = (jobId: string) =>
    watch().mutate((f) => ({
      ...f,
      channels: [
        {
          id: "UC1", name: "Creator", url: "u", enabled: true, addedAt: 0, seen: [], pending: [],
          history: [{ videoId: jobId, title: "v", at: Date.now(), jobId, status: "processing" as const }],
          settings: { clips: 3, minVideoSec: 240, perDay: 2 },
        },
      ],
    }));

  it("render their selected picks once ready, get an AI content review, and mark the watch history rendered", async () => {
    const job = await seedJob([clip(1, 100, 140), clip(2, 200, 240, { selected: false })], { automation: { channelId: "UC1", channelName: "Creator" }, settings: original });
    watching(job.id);
    await jobs().onReady(job);
    await vi.waitFor(() => expect(job.clips[0]!.render.status).toBe("done"), { timeout: 5000 });
    expect(job.clips[1]!.render.status).toBe("none");
    await vi.waitFor(() => expect(watch().get().channels[0]!.history[0]!.status).toBe("rendered"), { timeout: 5000 });
    expect(reviewContent).toHaveBeenCalledTimes(1);
    expect(reviewContent.mock.calls[0]![0]).toMatchObject({ clipTitle: "t1", transcript: expect.stringContaining("Olha") });
    expect(job.clips[0]!.contentReview).toMatchObject({ verdict: "ok" });
  });
  it("an automation job whose picks all failed review is recorded as an error, nothing rendered", async () => {
    const job = await seedJob([clip(1, 100, 140, { selected: false })], { automation: { channelId: "UC1", channelName: "Creator" }, settings: original });
    watching(job.id);
    await jobs().onReady(job);
    expect(job.clips[0]!.render.status).toBe("none");
    expect(watch().get().channels[0]!.history[0]).toMatchObject({ status: "error", error: expect.stringMatching(/no clip/i) });
  });
  it("a manual render with no posting account connected skips the content review", async () => {
    const job = await seedJob([clip(1, 100, 140)], { settings: original });
    await jobs().render(job.id, [1]);
    await vi.waitFor(() => expect(job.clips[0]!.render.status).toBe("done"), { timeout: 5000 });
    expect(reviewContent).not.toHaveBeenCalled();
  });
});
