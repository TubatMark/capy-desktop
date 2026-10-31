import { describe, expect, it, vi } from "vitest";
vi.mock("../server/paths", () => ({ OUTPUT_ROOT: "/out" }));
import { SHORT_HOLD_MS, isRenderedShort, removableShorts } from "../server/shorts-cleanup";
import { longDayItems } from "../lib/longform";
import { shortColumn } from "../lib/queue-calendar";

const NOW = 2_000_000_000_000;
const old = NOW - SHORT_HOLD_MS;
const job = (id: string, n: number, file = `/out/${id}/01.mp4`, status = "done") => ({ id, clips: [{ n, render: { status, file } }] });

describe("deleting rendered Shorts", () => {
  it("deletes only once every post of the clip is done and 48 hours have passed", () => {
    const run = (entries: object[]) => removableShorts([job("a", 1)], entries as never, NOW, "/out");
    expect(run([{ jobId: "a", n: 1, status: "posted", slotAt: old }])).toEqual(["/out/a/01.mp4"]);
    expect(run([{ jobId: "a", n: 1, status: "posted", slotAt: old + 1 }])).toEqual([]);
    expect(run([{ jobId: "a", n: 1, status: "scheduled", slotAt: old }])).toEqual([]);
    expect(run([{ jobId: "a", n: 1, status: "rejected", slotAt: old }])).toEqual([]);
    expect(run([{ jobId: "a", n: 1, status: "posted", slotAt: old }, { jobId: "a", n: 1, status: "failed", slotAt: old }])).toEqual([]);
    expect(run([{ jobId: "a", n: 1, status: "posted", slotAt: old }, { jobId: "a", n: 1, status: "rejected" }])).toEqual(["/out/a/01.mp4"]);
    expect(run([])).toEqual([]);
  });

  it("goes by the latest post of a clip", () => {
    const entries = [{ jobId: "a", n: 1, status: "posted", slotAt: old }, { jobId: "a", n: 1, status: "posted", slotAt: NOW - 1000 }];
    expect(removableShorts([job("a", 1)], entries as never, NOW, "/out")).toEqual([]);
  });

  it("never touches footage, scratch, long-form or anything outside the folder", () => {
    for (const bad of ["/out/a/work/01.src.mp4", "/out/a/x.src.mp4", "/out/.worker/x.mp4", "/out/.long-form/master.mp4", "/etc/x.mp4", "/out/a/words.json", "/out/x.mp4"]) expect(isRenderedShort(bad, "/out")).toBe(false);
    expect(isRenderedShort("/out/a/01-clip.mp4", "/out")).toBe(true);
    const posted = [{ jobId: "a", n: 1, status: "posted", slotAt: old }];
    expect(removableShorts([job("a", 1, "/out/a/work/01.src.mp4")], posted as never, NOW, "/out")).toEqual([]);
    expect(removableShorts([job("a", 1, "/out/a/01.mp4", "rendering")], posted as never, NOW, "/out")).toEqual([]);
  });

  it("leaves Studio exports alone", () => {
    expect(removableShorts([job("a", 1)], [{ jobId: "a", n: 1, status: "posted", slotAt: old, source: {} }] as never, NOW, "/out")).toEqual([]);
  });
});

describe("the Short form board", () => {
  it("puts a clip where it most needs looking at", () => {
    const col = (...s: string[]) => shortColumn(s.map((status) => ({ status })) as never);
    expect(col("review")).toBe("waiting");
    expect(col("scheduled")).toBe("scheduled");
    expect(col("posting", "scheduled")).toBe("posting");
    expect(col("posted", "rejected")).toBe("posted");
    expect(col("rejected")).toBe("skipped");
    expect(col("posted", "failed")).toBe("attention");
    expect(col("posted", "needs_action")).toBe("attention");
  });
});

describe("the long-form calendar", () => {
  const v = (over: object) => ({ id: "a", title: "t", creator: "c", status: "private", clips: [], createdAt: 1, updatedAt: 5, ...over }) as never;
  it("dates a video by when it went live, is booked, or a projection", () => {
    expect(longDayItems([v({ youtube: { publishedAt: 9 } })], {})[0]).toMatchObject({ at: 9, kind: "posted", booked: true });
    expect(longDayItems([v({})], { a: { at: 7, booked: true } })[0]).toMatchObject({ at: 7, kind: "scheduled", booked: true });
    expect(longDayItems([v({})], { a: { at: 7, booked: false } })[0]).toMatchObject({ kind: "scheduled", booked: false });
    expect(longDayItems([v({})], { a: { at: 7, booked: false, needsOwner: true } })[0]!.kind).toBe("attention");
    expect(longDayItems([v({ error: "x" })], {})[0]).toMatchObject({ at: 5, kind: "attention" });
    expect(longDayItems([v({})], {})).toEqual([]);
  });
});


describe("newest original first", () => {
  const entry = (over: object) => ({ key: "k", jobId: "a", n: 1, platform: "youtube", status: "scheduled", autoScheduledAt: 1, slotAt: NOW, history: [], createdAt: 100, updatedAt: 100, text: {}, attempts: 0, clipTitle: "t", ...over }) as never;
  it("gives the slot of the oldest post to a newer clip, and leaves hand-moved or uploaded posts alone", async () => {
    const { bumpOlderPost } = await import("../server/queue");
    const older = entry({ key: "old", jobId: "o", createdAt: 100 });
    const newer = entry({ key: "new", jobId: "n", createdAt: 500 });
    const out = bumpOlderPost([older, newer], 400, new Date(NOW))!;
    expect((out as { key: string; status: string }[]).find((e) => e.key === "old")!.status).toBe("review");
    expect((out as { key: string; status: string }[]).find((e) => e.key === "new")!.status).toBe("scheduled");
    expect(bumpOlderPost([newer], 400, new Date(NOW))).toBeNull();
    expect(bumpOlderPost([entry({ createdAt: 100, remoteSchedule: { publishAt: 1, uploadAheadMinutes: 1, schedulePolicy: "youtube-schedule-v1" } })], 400, new Date(NOW))).toBeNull();
    expect(bumpOlderPost([entry({ createdAt: 100, history: [{ t: 1, msg: "Moved to Mon" }] })], 400, new Date(NOW))).toBeNull();
  });
  it("re-slots so a newer original isn't a day behind an older one", async () => {
    const { respace } = await import("../server/queue");
    const start = new Date("2026-11-02T00:00:00Z");
    const day = 86400_000;
    const older = entry({ key: "old:1:youtube", jobId: "old", createdAt: 100, slotAt: start.getTime() + 20 * 3600_000 });
    const newer = entry({ key: "new:1:youtube", jobId: "new", createdAt: 500, slotAt: start.getTime() + day + 20 * 3600_000 });
    const out = respace([older, newer], "America/New_York", start) as unknown as { key: string; slotAt: number }[];
    const at = (k: string) => out.find((e) => e.key === k)!.slotAt;
    expect(at("new:1:youtube")).toBeLessThanOrEqual(at("old:1:youtube"));
    const inOrder = respace([entry({ ...(newer as object), slotAt: start.getTime() + 20 * 3600_000 }), entry({ ...(older as object), slotAt: start.getTime() + day + 20 * 3600_000 })], "America/New_York", start) as unknown as { key: string; history: unknown[] }[];
    expect(inOrder.every((e) => e.history.length === 0)).toBe(true);
  });
  it("drops a post that would go out too long after its original", async () => {
    const { expireLatePosts } = await import("../server/queue");
    const late = entry({ key: "late", createdAt: NOW - 100, slotAt: NOW + 100 });
    const ok = entry({ key: "ok", createdAt: NOW - 10, slotAt: NOW + 10 });
    const out = expireLatePosts([late, ok], 50, new Date(NOW)) as unknown as { key: string; status: string }[];
    expect(out.find((e) => e.key === "late")!.status).toBe("rejected");
    expect(out.find((e) => e.key === "ok")!.status).toBe("scheduled");
  });
});
