import { describe, expect, it } from "vitest";
import { DEFAULT_TUNING, MIN_AGE_MS, REACHED_FEED, judge, type PostedRow } from "../lib/daily-check";

const NOW = 2_000_000_000_000;
const row = (over: Partial<PostedRow> = {}): PostedRow => ({ videoId: "v", title: "t", group: "plain", postedAt: NOW - MIN_AGE_MS, views: 5, feedViews: 0, ...over });
const many = (n: number, over: Partial<PostedRow> = {}) => Array.from({ length: n }, (_, i) => row({ videoId: `v${i}`, ...over }));

describe("judging posted Shorts", () => {
  it("doesn't judge posts too new to have numbers, or too old to matter", () => {
    const { report } = judge([row({ postedAt: NOW - 1000 }), row({ postedAt: NOW - 40 * 86400_000 })], DEFAULT_TUNING, NOW);
    expect(report).toMatchObject({ judged: 0, health: "too-early" });
  });
  it("says plainly whether Shorts are reaching the feed", () => {
    const h = (rows: PostedRow[]) => judge(rows, DEFAULT_TUNING, NOW).report.health;
    expect(h(many(6))).toBe("not-reaching");
    expect(h([...many(9), row({ feedViews: REACHED_FEED })])).toBe("weak");
    expect(h([...many(6), ...many(4, { feedViews: 2000 })])).toBe("working");
    expect(h(many(4))).toBe("too-early");
  });
});

describe("acting on the numbers", () => {
  it("narrates everything once plain Shorts have clearly failed, once", () => {
    const first = judge(many(10), { ...DEFAULT_TUNING, narrate: "half" }, NOW);
    expect(first.tuning.narrate).toBe("all");
    expect(first.report.actions[0]).toMatch(/Narrating every new Short: 0 of 10/);
    const again = judge(many(10), first.tuning, NOW);
    expect(again.report.actions).toEqual([]);
    expect(judge(many(9), { ...DEFAULT_TUNING, narrate: "half" }, NOW).tuning.narrate).toBe("half");
  });
  it("leaves things alone when plain Shorts are working", () => {
    expect(judge(many(10, { feedViews: 2000 }), { ...DEFAULT_TUNING, narrate: "half" }, NOW).tuning.narrate).toBe("half");
  });
  it("stops narrating when it clearly does worse", () => {
    const rows = [...many(10, { feedViews: 2000 }), ...many(10, { group: "narrated" })];
    const out = judge(rows, DEFAULT_TUNING, NOW);
    expect(out.tuning.narrate).toBe("off");
    expect(out.report.actions[0]).toMatch(/Stopped narrating/);
  });
  it("asks the owner when narration hasn't helped either", () => {
    const out = judge([...many(10), ...many(10, { group: "narrated" })], { ...DEFAULT_TUNING, narrate: "all" }, NOW);
    expect(out.report.needsYou.join(" ")).toMatch(/AI commentary isn't enough/);
  });
  it("never overrides the owner's choice", () => {
    const out = judge(many(10), { ...DEFAULT_TUNING, narrate: "half", narrateManual: "half" }, NOW);
    expect(out.tuning.narrate).toBe("half");
    expect(out.report.actions).toEqual([]);
  });
  it("doesn't wait on anyone when nothing is reaching the feed", () => {
    expect(judge(many(6), DEFAULT_TUNING, NOW).report.needsYou).toEqual([]);
  });
  it("tunes clip length only with enough viewers, within limits, and not too often", () => {
    const seen = (pct: number) => many(5, { views: 500, avgViewPct: pct, feedViews: 300 });
    expect(judge(many(5, { views: 5, avgViewPct: 10 }), DEFAULT_TUNING, NOW).tuning.clipMaxSec).toBe(40);
    const short = judge(seen(40), DEFAULT_TUNING, NOW).tuning;
    expect(short).toMatchObject({ clipMaxSec: 35, clipChangedAt: NOW });
    expect(judge(seen(40), short, NOW + 1000).tuning.clipMaxSec).toBe(35);
    expect(judge(seen(90), DEFAULT_TUNING, NOW).tuning.clipMaxSec).toBe(45);
    expect(judge(seen(60), DEFAULT_TUNING, NOW).tuning.clipMaxSec).toBe(40);
    expect(judge(seen(40), { ...DEFAULT_TUNING, clipMaxSec: 25 }, NOW).tuning.clipMaxSec).toBe(25);
    expect(judge(seen(90), { ...DEFAULT_TUNING, clipMaxSec: 45 }, NOW).tuning.clipMaxSec).toBe(45);
  });
  it("names the creators doing best", () => {
    const rows = [...many(3, { creator: "A", feedViews: 10 }), ...many(3, { creator: "B", feedViews: 500 })];
    expect(judge(rows, DEFAULT_TUNING, NOW).report.bestCreators[0]).toMatchObject({ creator: "B", feedViews: 1500, posts: 3 });
  });
});
