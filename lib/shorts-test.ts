/** The narrated Shorts test: half of new clips get the host's commentary, and feed views decide. No node imports here. */

export interface ShortTestState {
  on: boolean;
  startedAt?: number;
}

export interface ShortTestResult {
  videoId: string;
  group: "narrated" | "plain";
  postedAt: number;
  views: number;
  feedViews: number;
  /** Viewers who stayed past the first seconds, as a share of views. */
  stayed?: number;
}

export interface ShortTestGroup {
  posts: number;
  /** Posts YouTube actually tried in the feed. */
  reachedFeed: number;
  feedViews: number;
  medianFeedViews: number;
  /** Across this group's Shorts, weighted by views. */
  stayedToWatch?: number;
}

export interface ShortTestSummary {
  narrated: ShortTestGroup;
  plain: ShortTestGroup;
  /** Plain words for the owner, and no winner before there's enough to compare. */
  verdict: string;
}

/** Analytics lag by about two days, so newer posts would all look like flops. */
export const SHORT_TEST_MIN_AGE_MS = 72 * 3600_000;
export const SHORT_TEST_MIN_POSTS = 10;
/** A view or two from a stray swipe isn't YouTube testing a Short in the feed. */
export const REACHED_FEED_VIEWS = 100;

/**
 * Order waiting clips so narrated and plain take turns, each side keeping its own freshest-first order, which gives
 * one of each a day at two posts a day. A side with nothing waiting doesn't hold the other back.
 */
export function alternateByTest<T>(items: T[], groupOf: (item: T) => "narrated" | "plain", last?: "narrated" | "plain"): T[] {
  const rest = { narrated: items.filter((i) => groupOf(i) === "narrated"), plain: items.filter((i) => groupOf(i) === "plain") };
  const out: T[] = [];
  let next: "narrated" | "plain" = last === "narrated" ? "plain" : "narrated";
  while (rest.narrated.length || rest.plain.length) {
    const side = rest[next].length ? next : next === "narrated" ? "plain" : "narrated";
    out.push(rest[side].shift()!);
    next = side === "narrated" ? "plain" : "narrated";
  }
  return out;
}

const group = (rows: ShortTestResult[]): ShortTestGroup => {
  const feed = rows.map((r) => r.feedViews).sort((a, b) => a - b);
  const mid = feed.length >> 1;
  return {
    posts: rows.length,
    reachedFeed: rows.filter((r) => r.feedViews >= REACHED_FEED_VIEWS).length,
    feedViews: feed.reduce((a, b) => a + b, 0),
    stayedToWatch: (() => {
      const known = rows.filter((r) => r.stayed !== undefined && r.views > 0);
      const views = known.reduce((a, r) => a + r.views, 0);
      return views ? known.reduce((a, r) => a + r.stayed! * r.views, 0) / views : undefined;
    })(),
    medianFeedViews: !feed.length ? 0 : feed.length % 2 ? feed[mid]! : Math.round((feed[mid - 1]! + feed[mid]!) / 2),
  };
};

export function shortTestSummary(results: ShortTestResult[], now: number): ShortTestSummary {
  const old = results.filter((r) => now - r.postedAt >= SHORT_TEST_MIN_AGE_MS);
  const narrated = group(old.filter((r) => r.group === "narrated"));
  const plain = group(old.filter((r) => r.group === "plain"));
  let verdict: string;
  if (narrated.posts < SHORT_TEST_MIN_POSTS || plain.posts < SHORT_TEST_MIN_POSTS) {
    verdict = `Too early to tell: each group needs ${SHORT_TEST_MIN_POSTS} Shorts that are at least 3 days old.`;
  } else if (narrated.reachedFeed > plain.reachedFeed && narrated.feedViews > plain.feedViews) {
    verdict = "Narrated Shorts are reaching the feed more often. Worth narrating every Short.";
  } else if (plain.reachedFeed > narrated.reachedFeed && plain.feedViews > narrated.feedViews) {
    verdict = "Plain Shorts are doing better, so narration isn't helping.";
  } else if (!narrated.reachedFeed && !plain.reachedFeed) {
    verdict = "Neither group is reaching the feed, so this commentary isn't enough on its own.";
  } else {
    verdict = "No clear difference yet.";
  }
  return { narrated, plain, verdict };
}
