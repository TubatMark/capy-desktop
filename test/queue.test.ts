import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { approve, markResult, queue, reconcileMissed, reconnected, recoverInterrupted, reject, resetQueueCache, summary, taken, upsertForRender, type ClipInfo } from "../server/queue";
import type { QueueEntry } from "../lib/types";

const now = new Date("2026-09-23T10:00:00Z"); // Wed 6:00 ET
const tz = "America/New_York";
const H = 3_600_000;
const clip = (n: number, extra: Partial<ClipInfo> = {}): ClipInfo => ({
  jobId: "J",
  n,
  clipTitle: `Clip ${n}`,
  start: n * 100,
  end: n * 100 + 40,
  videoUrl: `/api/media/${n}.mp4?v=1`,
  publish: { ytTitle: `T${n} #shorts`, description: "D\nCredit: X\n#shorts", hashtags: ["shorts"] },
  hook: `Hook ${n}`,
  ...extra,
});
const all = ["youtube", "instagram", "tiktok"] as const;
const byKey = (e: QueueEntry[], k: string) => e.find((x) => x.key === k)!;

describe("upsertForRender", () => {
  it("creates one review entry per platform with that platform's text, without duplicates", () => {
    let e = upsertForRender([], clip(1), [...all], now);
    e = upsertForRender(e, clip(1), [...all], now);
    expect(e.map((x) => x.key)).toEqual(["J:1:youtube", "J:1:instagram", "J:1:tiktok"]);
    expect(e.every((x) => x.status === "review")).toBe(true);
    expect(byKey(e, "J:1:youtube").text.title).toBe("T1 #shorts");
    expect(byKey(e, "J:1:instagram").text.caption!.startsWith("Hook 1")).toBe(true);
  });
  it("re-render keeps scheduled slots, and leaves posted/posting/rejected alone", () => {
    let e = upsertForRender([], clip(1), [...all], now);
    e = e.map((x) =>
      x.platform === "youtube" ? { ...x, status: "scheduled" as const, slotAt: 123 } : x.platform === "instagram" ? { ...x, status: "posted" as const, videoUrl: "old" } : { ...x, status: "rejected" as const, videoUrl: "old" },
    );
    e = upsertForRender(e, clip(1, { videoUrl: "/api/media/1.mp4?v=2" }), [...all], now);
    expect(byKey(e, "J:1:youtube")).toMatchObject({ status: "scheduled", slotAt: 123, videoUrl: "/api/media/1.mp4?v=2" });
    expect(byKey(e, "J:1:instagram")).toMatchObject({ status: "posted", videoUrl: "old" });
    expect(byKey(e, "J:1:tiktok")).toMatchObject({ status: "rejected", videoUrl: "old" });
  });
  it("keeps text the user edited during review", () => {
    let e = upsertForRender([], clip(1), ["youtube"], now);
    e = e.map((x) => ({ ...x, text: { ...x.text, title: "Mine" } }));
    e = upsertForRender(e, clip(1, { publish: { ytTitle: "New AI title", description: "", hashtags: [] } }), ["youtube"], now);
    expect(byKey(e, "J:1:youtube").text.title).toBe("Mine");
  });
});

describe("approve / reject", () => {
  it("gives a clip's platforms one shared slot", () => {
    const { entries, scheduled } = approve(upsertForRender([], clip(1), [...all], now), "J", 1, { audienceTz: tz, now });
    expect(scheduled).toHaveLength(3);
    expect(new Set(entries.map((x) => x.slotAt)).size).toBe(1);
    expect(entries.every((x) => x.status === "scheduled")).toBe(true);
  });
  it("approving a whole video spaces clips 2/day/platform, 4h apart", () => {
    let e: QueueEntry[] = [];
    for (let n = 1; n <= 6; n++) e = upsertForRender(e, clip(n), ["youtube"], now);
    const { entries } = approve(e, "J", undefined, { audienceTz: tz, now });
    const slots = entries.map((x) => x.slotAt!).sort((a, b) => a - b);
    for (let i = 1; i < slots.length; i++) expect(slots[i]! - slots[i - 1]!).toBeGreaterThanOrEqual(4 * H);
    const days = new Set(slots.map((t) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t))));
    expect(days.size).toBe(3);
  });
  it("platforms not chosen at approval are rejected", () => {
    const { entries } = approve(upsertForRender([], clip(1), [...all], now), "J", 1, { platforms: ["youtube"], audienceTz: tz, now });
    expect(byKey(entries, "J:1:youtube").status).toBe("scheduled");
    expect(byKey(entries, "J:1:tiktok").status).toBe("rejected");
  });
  it("reject frees the slot for the next approval", () => {
    let e = upsertForRender(upsertForRender([], clip(1), ["youtube"], now), clip(2), ["youtube"], now);
    e = approve(e, "J", 1, { audienceTz: tz, now }).entries;
    const first = byKey(e, "J:1:youtube").slotAt;
    e = reject(e, "J:1:youtube", now);
    e = approve(e, "J", 2, { audienceTz: tz, now }).entries;
    expect(byKey(e, "J:2:youtube").slotAt).toBe(first);
  });
});

describe("missed and interrupted", () => {
  const sched = (slotAt: number): QueueEntry[] => upsertForRender([], clip(1), ["youtube"], now).map((x) => ({ ...x, status: "scheduled" as const, slotAt }));
  it("under 2h late stays due; over 2h moves to a new slot with a note", () => {
    const due = reconcileMissed(sched(now.getTime() - 2 * H + 60_000), tz, now);
    expect(due[0]!.slotAt).toBe(now.getTime() - 2 * H + 60_000);
    const moved = reconcileMissed(sched(now.getTime() - 2 * H - 60_000), tz, now);
    expect(moved[0]!.slotAt!).toBeGreaterThan(now.getTime());
    expect(moved[0]!.history.at(-1)!.msg).toContain("Missed");
  });
  it("posting at startup goes back to scheduled, due now", () => {
    const e = recoverInterrupted(sched(1).map((x) => ({ ...x, status: "posting" as const })), now);
    expect(e[0]).toMatchObject({ status: "scheduled", slotAt: now.getTime() });
    expect(e[0]!.history.at(-1)!.msg).toContain("Interrupted");
  });
});

describe("markResult", () => {
  const base = (): QueueEntry[] => upsertForRender([], clip(1), ["youtube"], now).map((x) => ({ ...x, status: "posting" as const, slotAt: now.getTime() }));
  it("backs off 2, 10, 30 minutes, then fails for good", () => {
    let e = base();
    const err = { error: { message: "503", retryable: true, auth: false } };
    for (const mins of [2, 10, 30]) {
      e = markResult(e, "J:1:youtube", err, now);
      expect(e[0]).toMatchObject({ status: "failed", nextTryAt: now.getTime() + mins * 60_000 });
      e = e.map((x) => ({ ...x, status: "posting" as const }));
    }
    e = markResult(e, "J:1:youtube", err, now);
    expect(e[0]!.status).toBe("failed");
    expect(e[0]!.nextTryAt).toBeUndefined();
  });
  it("auth errors wait for a reconnect", () => {
    const e = markResult(base(), "J:1:youtube", { error: { message: "401", retryable: false, auth: true } }, now);
    expect(e[0]).toMatchObject({ status: "needs_action", authBlocked: true });
    const back = reconnected(e, "youtube", tz, now);
    expect(back[0]).toMatchObject({ status: "scheduled", authBlocked: false });
    expect(back[0]!.slotAt!).toBeGreaterThanOrEqual(now.getTime());
  });
  it("records posted and needs_action outcomes", () => {
    expect(markResult(base(), "J:1:youtube", { outcome: { kind: "posted", id: "a", url: "u" } }, now)[0]).toMatchObject({ status: "posted", result: { id: "a", url: "u" } });
    expect(markResult(base(), "J:1:youtube", { outcome: { kind: "needs_action", id: "a", note: "Open Studio" } }, now)[0]).toMatchObject({ status: "needs_action", result: { note: "Open Studio" } });
  });
});

describe("summary", () => {
  it("counts review entries and finds the next post", () => {
    let e = upsertForRender(upsertForRender([], clip(1), [...all], now), clip(2), ["youtube"], now);
    e = approve(e, "J", 1, { audienceTz: tz, now }).entries;
    const s = summary(e, now);
    expect(s.review).toBe(1);
    expect(s.activeCount).toBe(3);
    expect(s.nextPost!.platforms.sort()).toEqual(["instagram", "tiktok", "youtube"]);
  });
});

describe("store", () => {
  let root: string;
  let n = 0;
  beforeAll(() => (root = mkdtempSync(path.join(tmpdir(), "capy-queue-"))));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    process.env.CAPY_DATA_DIR = path.join(root, String(++n));
    resetQueueCache();
  });
  it("persists mutations; loading never touches in-flight posts (the poster that owns the lock recovers them)", () => {
    queue().mutate((e) => upsertForRender(e, clip(1), ["youtube"], now).map((x) => ({ ...x, status: "posting" as const })));
    resetQueueCache();
    expect(queue().list()[0]!.status).toBe("posting");
  });
});

describe("clip identity (a re-cut clip at the same number)", () => {
  it("a different cut of clip n archives the old entry and starts a fresh review with new text", () => {
    let e = upsertForRender([], clip(1), ["youtube"], now);
    e = approve(e, "J", 1, { audienceTz: tz, now }).entries;
    e = upsertForRender(e, clip(1, { start: 500, end: 540, publish: { ytTitle: "Other moment", description: "", hashtags: [] } }), ["youtube"], now);
    const live = e.filter((x) => x.key === "J:1:youtube");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: "review", text: { title: "Other moment" } });
    expect(live[0]!.slotAt).toBeUndefined();
    const old = e.find((x) => x.key !== "J:1:youtube")!;
    expect(old.status).toBe("rejected");
    expect(old.history.at(-1)!.msg).toContain("different");
  });
  it("a posted clip stays posted; the new cut at the same number still gets reviewed", () => {
    let e: QueueEntry[] = upsertForRender([], clip(1), ["youtube"], now).map((x) => ({ ...x, status: "posted" as const, result: { id: "v1" } }));
    e = upsertForRender(e, clip(1, { start: 500, end: 540 }), ["youtube"], now);
    expect(e.find((x) => x.status === "posted")!.result!.id).toBe("v1");
    expect(e.find((x) => x.key === "J:1:youtube")!.status).toBe("review");
  });
  it("re-rendering the same cut after a 'file missing' puts it back on the schedule", () => {
    let e: QueueEntry[] = upsertForRender([], clip(1), ["youtube"], now).map((x) => ({ ...x, status: "needs_action" as const, slotAt: 123, error: "Clip file missing, re-render it" }));
    e = upsertForRender(e, clip(1), ["youtube"], now);
    expect(e[0]).toMatchObject({ status: "scheduled", slotAt: 123, error: undefined });
  });
});

describe("taken", () => {
  it("counts posts that ended in needs_action (TikTok inbox, YouTube private) like posted ones", () => {
    const base = upsertForRender([], clip(1), ["tiktok"], now)[0]!;
    const sent = { ...base, status: "needs_action" as const, slotAt: now.getTime() - 3600_000, result: { id: "p1", note: "inbox" } };
    const missing = { ...base, key: "x", status: "needs_action" as const, slotAt: now.getTime() - 3600_000, error: "Clip file missing" };
    expect(taken([sent, missing], now)).toEqual([{ platform: "tiktok", at: sent.slotAt }]);
  });
});

describe("AI content review on queue entries", () => {
  const review = { verdict: "caution" as const, summary: "Title oversells", issues: [], at: 1 };
  it("new entries carry the clip's AI review, and a re-render refreshes it", () => {
    let e = upsertForRender([], clip(1, { aiReview: review }), ["youtube"], now);
    expect(e[0]!.aiReview).toEqual(review);
    e = upsertForRender(e, clip(1, { aiReview: { ...review, verdict: "ok", summary: "Fixed" } }), ["youtube"], now);
    expect(e[0]!.aiReview).toMatchObject({ verdict: "ok", summary: "Fixed" });
  });
});

describe("story entries", () => {
  it("carry their own fingerprint, link and made-for-kids flag", () => {
    const e = upsertForRender([], { ...clip(1), jobId: "story-st1", fp: "r123", link: "/stories/ser1/st1", madeForKids: true }, ["youtube"], now);
    expect(e[0]).toMatchObject({ fp: "r123", link: "/stories/ser1/st1", madeForKids: true });
  });
});
