import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addChannel, applyCheck, diffUploads, emptyWatch, markHistory, resetWatchCache, takeDue, watch } from "../server/watch";
import type { WatchFile } from "../lib/types";

const now = new Date("2026-10-06T15:00:00Z");
const H = 3_600_000;
const info = (id = "UC1", name = "Creator") => ({ id, name, handle: "@c", url: `https://www.youtube.com/channel/${id}/videos` });
const up = (id: string, duration?: number, live = false) => ({ id, title: `t-${id}`, duration, live });

describe("addChannel", () => {
  it("records current uploads as seen (no backfill)", () => {
    const f = addChannel(emptyWatch(), info(), [up("a", 600), up("b", 900)], { now });
    expect(f.channels[0]).toMatchObject({ id: "UC1", enabled: true, seen: ["a", "b"], pending: [] });
    expect(f.channels[0]!.settings).toEqual({ clips: 3, minVideoSec: 240, perDay: 2 });
  });
  it("with clipLatest, the newest clippable upload goes to pending", () => {
    const f = addChannel(emptyWatch(), info(), [up("short", 50), up("b", 900), up("c", 700)], { now, clipLatest: true });
    expect(f.channels[0]!.pending.map((p) => p.id)).toEqual(["b"]);
    expect(f.channels[0]!.seen).toEqual(["short", "c"]);
  });
  it("refuses a channel that is already watched", () => {
    const f = addChannel(emptyWatch(), info(), [], { now });
    expect(() => addChannel(f, info(), [], { now })).toThrow(/already/);
  });
});

describe("diffUploads / applyCheck", () => {
  const base = () => addChannel(emptyWatch(), info(), [up("a", 600)], { now });
  it("new long uploads become pending oldest first; short ones are skipped; live and unknown wait", () => {
    const ch = base().channels[0]!;
    const d = diffUploads(ch, [up("n2", 800), up("n1", 700), up("s", 30), up("live", undefined, true), up("prem"), up("a", 600)]);
    expect(d.fresh.map((u) => u.id)).toEqual(["n2", "n1"]);
    expect(d.skipped.map((u) => u.id)).toEqual(["s"]);
    expect(d.unknown.map((u) => u.id)).toEqual(["live", "prem"]);
    const f = applyCheck(base(), "UC1", [up("n2", 800), up("n1", 700), up("s", 30), up("prem")], now);
    const c = f.channels[0]!;
    expect(c.pending.map((p) => p.id)).toEqual(["n1", "n2"]);
    expect(c.seen).toEqual(expect.arrayContaining(["a", "s"]));
    expect(c.seen).not.toContain("prem");
    expect(c.lastCheckedAt).toBe(now.getTime());
    expect(applyCheck(f, "UC1", [up("n2", 800)], now).channels[0]!.pending).toHaveLength(2); // no duplicates
  });
});

describe("takeDue", () => {
  const withPending = (n: number, perDay = 2): WatchFile => {
    let f = addChannel(emptyWatch(), info(), [], { now });
    f = { ...f, channels: f.channels.map((c) => ({ ...c, settings: { ...c.settings, perDay } })) };
    return applyCheck(f, "UC1", Array.from({ length: n }, (_, i) => up(`v${n - i}`, 600)), now);
  };
  it("hands out the oldest pending video and records it as processing", () => {
    const { file, due } = takeDue(withPending(3), now);
    expect(due).toMatchObject({ channelId: "UC1", videoId: "v1" });
    expect(file.channels[0]!.pending.map((p) => p.id)).toEqual(["v2", "v3"]);
    expect(file.channels[0]!.seen).toContain("v1");
    expect(file.channels[0]!.history[0]).toMatchObject({ videoId: "v1", jobId: "v1", status: "processing" });
  });
  it("stops at the channel's daily cap and keeps the rest pending", () => {
    let f = withPending(3);
    f = takeDue(f, now).file;
    f = takeDue(f, now).file;
    const third = takeDue(f, now);
    expect(third.due).toBeUndefined();
    expect(third.file.channels[0]!.pending).toHaveLength(1);
    expect(takeDue(third.file, new Date(now.getTime() + 25 * H)).due).toMatchObject({ videoId: "v3" });
  });
  it("stops at the overall daily cap across channels", () => {
    let f = withPending(5, 10);
    f = { ...f, maxPerDay: 2 };
    f = takeDue(f, now).file;
    f = takeDue(f, now).file;
    expect(takeDue(f, now).due).toBeUndefined();
  });
  it("skips disabled channels", () => {
    let f = withPending(1);
    f = { ...f, channels: f.channels.map((c) => ({ ...c, enabled: false })) };
    expect(takeDue(f, now).due).toBeUndefined();
  });
});

describe("markHistory", () => {
  it("updates the entry for a job", () => {
    const f = takeDue(applyCheck(addChannel(emptyWatch(), info(), [], { now }), "UC1", [up("v", 600)], now), now).file;
    const g = markHistory(f, "v", "error", "No captions");
    expect(g.channels[0]!.history[0]).toMatchObject({ status: "error", error: "No captions" });
  });
});

describe("store", () => {
  let root: string;
  let n = 0;
  beforeAll(() => (root = mkdtempSync(path.join(tmpdir(), "capy-watch-"))));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    process.env.CAPY_DATA_DIR = path.join(root, String(++n));
    resetWatchCache();
  });
  it("starts empty with defaults and persists mutations", () => {
    expect(watch().get()).toMatchObject({ channels: [], maxPerDay: 6, intervalMin: 60 });
    watch().mutate((f) => addChannel(f, info(), [], { now }));
    resetWatchCache();
    expect(watch().get().channels).toHaveLength(1);
  });
});
