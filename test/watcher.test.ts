import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { watcherTick, type WatcherDeps } from "../server/watcher";
import { addChannel, resetWatchCache, watch } from "../server/watch";
import type { Upload } from "../src/youtube";

let root: string;
let n = 0;
beforeAll(() => (root = mkdtempSync(path.join(tmpdir(), "capy-watcher-"))));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(root, String(++n));
  resetWatchCache();
});

const t0 = new Date("2026-10-06T15:00:00Z");
const up = (id: string, duration = 600): Upload => ({ id, title: `t-${id}`, duration, live: false });
const info = (id: string) => ({ id, name: `ch-${id}`, url: `https://www.youtube.com/channel/${id}/videos` });

function deps(over: Partial<WatcherDeps> & { uploads?: Record<string, Upload[] | Error> } = {}) {
  const created: { videoId: string; settings: unknown; automation: unknown }[] = [];
  const d: WatcherDeps = {
    now: () => t0,
    lock: () => "held",
    list: async (url) => {
      const id = url.split("/")[4]!;
      const r = over.uploads?.[id] ?? [];
      if (r instanceof Error) throw r;
      return r;
    },
    createJob: async (videoId, settings, automation) => void created.push({ videoId, settings, automation }),
    ...over,
  };
  return { d, created };
}

describe("watcherTick", () => {
  it("checks channels when due, then starts one new video at a time", async () => {
    watch().mutate((f) => addChannel(f, info("UC1"), [up("old")], { now: t0 }));
    const { d, created } = deps({ uploads: { UC1: [up("new2"), up("new1"), up("old")] } });
    await watcherTick(d);
    expect(created.map((c) => c.videoId)).toEqual(["new1"]);
    expect(created[0]!.settings).toMatchObject({ count: 3 });
    expect(created[0]!.automation).toEqual({ channelId: "UC1", channelName: "ch-UC1" });
    await watcherTick(d); // new1 is still processing: wait
    expect(created).toHaveLength(1);
    watch().mutate((f) => ({ ...f, channels: f.channels.map((c) => ({ ...c, history: c.history.map((h) => ({ ...h, status: "rendered" as const })) })) }));
    await watcherTick(d);
    expect(created.map((c) => c.videoId)).toEqual(["new1", "new2"]);
  });
  it("doesn't list channels again before the interval is up", async () => {
    watch().mutate((f) => addChannel(f, info("UC1"), [], { now: t0 }));
    let lists = 0;
    const { d } = deps({ list: async () => (lists++, []) });
    await watcherTick(d);
    await watcherTick({ ...d, now: () => new Date(t0.getTime() + 30 * 60_000) });
    expect(lists).toBe(1);
    await watcherTick({ ...d, now: () => new Date(t0.getTime() + 61 * 60_000) });
    expect(lists).toBe(2);
    await watcherTick({ ...d, now: () => new Date(t0.getTime() + 62 * 60_000) }, { force: true });
    expect(lists).toBe(3);
  });
  it("a channel that fails to list keeps its error; the others still get checked", async () => {
    watch().mutate((f) => addChannel(addChannel(f, info("UC1"), [], { now: t0 }), info("UC2"), [], { now: t0 }));
    const { d, created } = deps({ uploads: { UC1: new Error("This channel does not exist"), UC2: [up("x")] } });
    await watcherTick(d);
    const [a, b] = watch().get().channels;
    expect(a!.lastError).toContain("does not exist");
    expect(b!.lastError).toBeUndefined();
    expect(created.map((c) => c.videoId)).toEqual(["x"]);
  });
  it("a job that fails to start is recorded and the next video can go", async () => {
    watch().mutate((f) => addChannel(f, info("UC1"), [], { now: t0 }));
    const { d } = deps({
      uploads: { UC1: [up("b"), up("a")] },
      createJob: async () => {
        throw new Error("yt-dlp failed");
      },
    });
    await watcherTick(d);
    expect(watch().get().channels[0]!.history[0]).toMatchObject({ videoId: "a", status: "error", error: "yt-dlp failed" });
  });
  it("a video stuck processing for 6 hours stops blocking the line", async () => {
    watch().mutate((f) => addChannel(f, info("UC1"), [], { now: t0 }));
    const { d, created } = deps({ uploads: { UC1: [up("b"), up("a")] } });
    await watcherTick(d);
    await watcherTick({ ...d, now: () => new Date(t0.getTime() + 7 * 3_600_000) });
    expect(created.map((c) => c.videoId)).toEqual(["a", "b"]);
    expect(watch().get().channels[0]!.history.find((h) => h.videoId === "a")).toMatchObject({ status: "error", error: expect.stringMatching(/too long/i) });
  });
  it("does nothing while another capy process holds the watcher lock", async () => {
    watch().mutate((f) => addChannel(f, info("UC1"), [], { now: t0 }));
    const { d, created } = deps({ lock: () => "busy", uploads: { UC1: [up("x")] } });
    await watcherTick(d);
    expect(created).toHaveLength(0);
    expect(watch().get().channels[0]!.lastCheckedAt).toBeUndefined();
  });
});
