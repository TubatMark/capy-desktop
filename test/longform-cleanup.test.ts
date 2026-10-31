import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const { root, state } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  return {
    root: fs.mkdtempSync(p.join(os.tmpdir(), "capy-lf-clean-")),
    state: { video: undefined as unknown, queue: [] as unknown[], saved: undefined as unknown },
  };
});
vi.mock("../server/paths", () => ({ OUTPUT_ROOT: root }));
vi.mock("../server/longform/store", () => ({
  LONG_FOLDER: ".long-form",
  videoDir: (id: string) => path.join(root, ".long-form", id),
  getVideo: () => state.video,
  queueEntries: () => state.queue,
  patchVideo: (_: string, p: object) => (state.saved = { ...(state.video as object), ...p }),
}));
import { HOLD_MS, cleanupBlock, cleanupPlan, freeSpace, isRemovable } from "../server/longform/cleanup";
import type { LongClip, LongVideo } from "../lib/longform";

const NOW = 2_000_000_000_000;
const put = (rel: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), "xxxx");
};
const clip = (n: number): LongClip => ({ jobId: "j", n, file: `job/work/0${n}.src.mp4`, segStart: 0, segEnd: 1, start: 0, end: 1, title: "", score: 8, channel: "c", sourceTitle: "", sourceUrl: "" });
const video = (over: Partial<LongVideo> = {}): LongVideo => ({
  id: "v1",
  creator: "c",
  status: "private",
  title: "t",
  clips: [clip(1), clip(2), clip(3), clip(4)],
  createdAt: 0,
  updatedAt: 0,
  youtube: { id: "yt", processedAt: NOW - HOLD_MS - 1 },
  ...over,
});

describe("free up space", () => {
  beforeEach(() => {
    for (const n of [1, 2, 3, 4]) put(`job/work/0${n}.src.mp4`);
    put("job/01-short.mp4");
    put("job/words.json");
    put(".long-form/v1/master.mp4");
    put(".long-form/v1/sections/00-intro.mp4");
    state.queue = [
      { jobId: "j", n: 1, status: "posted" },
      { jobId: "j", n: 2, status: "rejected" },
      { jobId: "j", n: 3, status: "scheduled" },
    ];
  });

  it("waits for processing and 48 hours, and never touches a rejected video", () => {
    expect(cleanupBlock(video({ youtube: undefined }), NOW)).toMatch(/Not uploaded/);
    expect(cleanupBlock(video({ youtube: { id: "yt" } }), NOW)).toMatch(/processing/);
    expect(cleanupBlock(video({ youtube: { id: "yt", processedAt: NOW - 3600_000 } }), NOW)).toMatch(/47 hours/);
    expect(cleanupBlock(video({ youtube: { id: "yt", processedAt: 1, rejected: "copyright" } }), NOW)).toMatch(/rejected/);
    expect(cleanupBlock(video(), NOW)).toBeUndefined();
  });

  it("keeps footage for Shorts that haven't posted", () => {
    const plan = cleanupPlan(video(), NOW, state.queue as never);
    const files = plan.files.map((f) => f.path);
    expect(files).toContain("job/work/01.src.mp4");
    expect(files).toContain("job/work/02.src.mp4");
    expect(files).toContain(".long-form/v1/master.mp4");
    expect(files).not.toContain("job/work/03.src.mp4");
    expect(files).not.toContain("job/work/04.src.mp4");
    expect(plan.kept.map((k) => k.path).sort()).toEqual(["job/work/03.src.mp4", "job/work/04.src.mp4"]);
  });

  it("refuses anything but source footage and this video's own folder", () => {
    expect(isRemovable("job/work/01.src.mp4", "v1")).toBe(true);
    expect(isRemovable(".long-form/v1/master.mp4", "v1")).toBe(true);
    for (const bad of ["job/01-short.mp4", "job/words.json", "job/work/whisper.json", ".long-form/v2/master.mp4", ".long-form/v1", "../outside.src.mp4", ".worker/work/x.src.mp4", "/etc/hosts"]) expect(isRemovable(bad, "v1")).toBe(false);
  });

  it("deletes the plan's files and nothing else", () => {
    state.video = video();
    const out = freeSpace("v1", NOW);
    expect(out.status).toBe("freed");
    expect(out.freed?.files).toBeGreaterThan(0);
    expect(existsSync(path.join(root, "job/work/01.src.mp4"))).toBe(false);
    expect(existsSync(path.join(root, ".long-form/v1"))).toBe(false);
    expect(existsSync(path.join(root, "job/work/03.src.mp4"))).toBe(true);
    expect(existsSync(path.join(root, "job/01-short.mp4"))).toBe(true);
    expect(existsSync(path.join(root, "job/words.json"))).toBe(true);
  });

  it("refuses to run early", () => {
    state.video = video({ youtube: { id: "yt", processedAt: NOW } });
    expect(() => freeSpace("v1", NOW)).toThrow(/Available in/);
    expect(existsSync(path.join(root, "job/work/01.src.mp4"))).toBe(true);
  });
});
