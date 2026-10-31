import { describe, expect, it, vi } from "vitest";
vi.mock("../server/accounts", () => ({ getAccessToken: vi.fn(), loadAccounts: () => ({ youtube: {} }) }));
import { shortTestGroup } from "../server/shorts-test";
import { alternateByTest, SHORT_TEST_MIN_AGE_MS, SHORT_TEST_MIN_POSTS, shortTestSummary, type ShortTestResult } from "../lib/shorts-test";
import { commentaryArgs, commentaryAss, fitsLength, middleAt, outroLength } from "../src/shorts-commentary";

const NOW = 2_000_000_000_000;
const old = NOW - SHORT_TEST_MIN_AGE_MS;
const results = (group: ShortTestResult["group"], feed: number[], postedAt = old): ShortTestResult[] => feed.map((feedViews, i) => ({ videoId: `${group}${i}`, group, postedAt, views: feedViews, feedViews }));
const many = (v: number) => Array.from({ length: SHORT_TEST_MIN_POSTS }, () => v);

describe("test groups", () => {
  it("keeps a clip in its group, and splits clips about evenly", () => {
    expect(shortTestGroup("job", 1)).toBe(shortTestGroup("job", 1));
    const narrated = Array.from({ length: 400 }, (_, i) => shortTestGroup(`job${i}`, 1)).filter((g) => g === "narrated").length;
    expect(narrated).toBeGreaterThan(150);
    expect(narrated).toBeLessThan(250);
  });
});

describe("taking turns", () => {
  it("alternates narrated and plain, freshest first, without one holding the other back", () => {
    const g = (x: string) => (x.startsWith("n") ? "narrated" as const : "plain" as const);
    expect(alternateByTest(["n1", "n2", "p1", "p2"], g)).toEqual(["n1", "p1", "n2", "p2"]);
    expect(alternateByTest(["n1", "p1"], g, "narrated")).toEqual(["p1", "n1"]);
    expect(alternateByTest(["p1", "p2"], g)).toEqual(["p1", "p2"]);
  });
});

describe("reading the results", () => {
  it("names no winner until both groups have enough old Shorts", () => {
    expect(shortTestSummary([...results("narrated", many(5000)), ...results("plain", [1, 2])], NOW).verdict).toMatch(/Too early/);
    expect(shortTestSummary([...results("narrated", many(5000), NOW - 1000), ...results("plain", many(1), NOW - 1000)], NOW).narrated.posts).toBe(0);
  });
  it("says which side won, and when neither reached the feed", () => {
    expect(shortTestSummary([...results("narrated", many(500)), ...results("plain", many(1))], NOW).verdict).toMatch(/Narrated Shorts are reaching/);
    expect(shortTestSummary([...results("narrated", many(1)), ...results("plain", many(500))], NOW).verdict).toMatch(/Plain Shorts/);
    expect(shortTestSummary([...results("narrated", many(5)), ...results("plain", many(3))], NOW).verdict).toMatch(/Neither/);
  });
  it("works out stayed to watch, weighted by views", () => {
    const rows: ShortTestResult[] = [
      { videoId: "a", group: "narrated", postedAt: old, views: 100, feedViews: 0, stayed: 0.6 },
      { videoId: "b", group: "narrated", postedAt: old, views: 300, feedViews: 0, stayed: 0.4 },
      { videoId: "c", group: "narrated", postedAt: old, views: 900, feedViews: 0 },
    ];
    expect(shortTestSummary(rows, NOW).narrated.stayedToWatch).toBeCloseTo(0.45);
    expect(shortTestSummary([], NOW).plain.stayedToWatch).toBeUndefined();
  });
  it("counts a stray view as not reaching the feed, and takes the median", () => {
    const s = shortTestSummary(results("narrated", [1, 50, 1000, 3000]), NOW);
    expect(s.narrated).toMatchObject({ posts: 4, reachedFeed: 2, feedViews: 4051, medianFeedViews: 525 });
  });
});

describe("line length", () => {
  it("keeps the opening from talking over the clip", () => {
    const n = (count: number) => Array.from({ length: count }, () => "word").join(" ");
    expect(fitsLength({ opening: n(16), middle: n(14), verdict: n(26) })).toBe(true);
    expect(fitsLength({ opening: n(17), middle: n(5), verdict: n(5) })).toBe(false);
    expect(fitsLength({ opening: n(5), middle: n(15), verdict: n(5) })).toBe(false);
    expect(fitsLength({ opening: n(5), middle: n(5), verdict: n(27) })).toBe(false);
  });
});

describe("the edit", () => {
  const o = { clip: "c.mp4", clipSeconds: 50, opening: "o.wav", openingSeconds: 3, verdict: "v.wav", verdictSeconds: 4, ass: "n.ass", out: "x.mp4", enc: "libx264" };
  it("adds the verdict after the clip's end, so its punchline is never talked over", () => {
    const { args, added } = commentaryArgs(o);
    expect(added).toBe(outroLength(4));
    expect(args[args.indexOf("-t") + 1]).toBe(String(50 + added));
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("concat=n=2:v=1:a=0");
    expect(filter).toContain("volume=0.12:enable='lt(t,3.25)'");
    expect(filter).toContain("loudnorm=I=-12");
    expect(filter).toContain("ass=filename=n.ass");
  });
  it("lowers the clip for the mid-clip comment too", () => {
    const { args } = commentaryArgs({ ...o, middle: { file: "m.wav", at: 20, seconds: 2 } });
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("between(t,19.9,22.25)");
    expect(filter).toContain("adelay=delays=20000:all=1");
    expect(filter).toContain("amix=inputs=3");
    expect(args).toContain("m.wav");
  });
  it("places the mid-clip comment in the longest pause of the middle stretch", () => {
    const w = [{ start: 0, end: 15 }, { start: 15.2, end: 22 }, { start: 24, end: 30 }, { start: 36, end: 38 }];
    expect(middleAt(w, 40)).toBe(22);
    expect(middleAt(w, 12)).toBeUndefined();
    expect(middleAt([], 40)).toBe(20);
  });
  it("keeps titles safe and masks slurs on screen", () => {
    const a = commentaryAss({ opening: "my nigga {\\b1} hi", openingEnd: 3, verdict: "fine", outroStart: 50, outroEnd: 54 });
    expect(a).toContain("my n**** /b1 hi");
    expect(a).toContain("0:00:50.10");
  });
});
