import { creatorName } from "./longform";

/** The daily check on posted videos: what counts as working, and what to do when it isn't. No node imports here. */

export interface PostedRow {
  videoId: string;
  title: string;
  group: "narrated" | "plain";
  postedAt: number;
  views: number;
  feedViews: number;
  stayed?: number;
  avgViewPct?: number;
  creator?: string;
}

export interface Tuning {
  /** Who gets narrated. */
  narrate: "half" | "all" | "off";
  /** The owner picked it: the daily check doesn't change it. */
  narrateManual?: "all" | "half";
  clipMaxSec: number;
  /** When clip length last changed: it needs time to show results. */
  clipChangedAt?: number;
  /** A test of going deep on fewer creators: their clips go first among similar ages. Empty means no focus. */
  focusCreators: string[];
}
export const DEFAULT_TUNING: Tuning = { narrate: "all", clipMaxSec: 40, focusCreators: ["Kai Cenat", "IShowSpeed"] };

export type Health = "too-early" | "working" | "weak" | "not-reaching";

export interface DailyReport {
  at: number;
  health: Health;
  summary: string;
  /** Posts old enough to judge. */
  judged: number;
  reachedFeed: number;
  medianViews: number;
  stayedToWatch?: number;
  bestCreators: { creator: string; feedViews: number; posts: number }[];
  /** How the focus creators are doing against the rest, once there's enough to compare. */
  focus?: string;
  /** What capy changed today. */
  actions: string[];
  /** Worth knowing; nothing waits on it. */
  needsYou: string[];
}

/** Analytics lag by about two days, so newer posts would all look like flops. */
export const MIN_AGE_MS = 72 * 3600_000;
const WINDOW_MS = 30 * 86400_000;
/** A view or two from a stray swipe isn't YouTube testing a Short in the feed. */
export const REACHED_FEED = 100;
const MIN_POSTS = 10;
/** Retention only means something with this many viewers. */
const MIN_VIEWS_FOR_RETENTION = 100;
const MIN_RETENTION_POSTS = 5;
const CLIP_CHANGE_GAP_MS = 7 * 86400_000;
const SHORTEST_CLIP = 25;
const LONGEST_CLIP = 45;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const reachRate = (rows: PostedRow[]) => (rows.length ? rows.filter((r) => r.feedViews >= REACHED_FEED).length / rows.length : 0);

/** Read the numbers, decide what to change. Pure, so every rule is testable. */
export function judge(rows: PostedRow[], tuning: Tuning, now: number): { report: DailyReport; tuning: Tuning } {
  const judged = rows.filter((r) => now - r.postedAt >= MIN_AGE_MS && now - r.postedAt <= WINDOW_MS);
  const reached = judged.filter((r) => r.feedViews >= REACHED_FEED);
  const narrated = judged.filter((r) => r.group === "narrated");
  const plain = judged.filter((r) => r.group === "plain");
  const next = { ...tuning };
  const actions: string[] = [];
  const needsYou: string[] = [];

  // what to post: plain clips have had their chance once there are enough of them
  if (tuning.narrateManual) {
    // the owner's call stands
  } else if (plain.length >= MIN_POSTS && reachRate(plain) < 0.1 && tuning.narrate !== "all") {
    next.narrate = "all";
    actions.push(`Narrating every new Short: ${plain.filter((r) => r.feedViews >= REACHED_FEED).length} of ${plain.length} plain Shorts reached the feed.`);
  } else if (narrated.length >= MIN_POSTS && plain.length >= MIN_POSTS && reachRate(plain) > reachRate(narrated) + 0.2 && tuning.narrate !== "off") {
    next.narrate = "off";
    actions.push(`Stopped narrating: plain Shorts reach the feed more often (${Math.round(reachRate(plain) * 100)}% against ${Math.round(reachRate(narrated) * 100)}%).`);
  }
  if (narrated.length >= MIN_POSTS && reachRate(narrated) < 0.1) {
    needsYou.push(`${narrated.length} narrated Shorts haven't reached the feed either, so AI commentary isn't enough on its own. Your own voice on a few clips, or a new channel, are the next things to try.`);
  }

  // how long clips are: only when enough people watched for retention to mean something
  const watched = judged.filter((r) => r.views >= MIN_VIEWS_FOR_RETENTION && r.avgViewPct !== undefined);
  if (watched.length >= MIN_RETENTION_POSTS && now - (tuning.clipChangedAt ?? 0) >= CLIP_CHANGE_GAP_MS) {
    const held = median(watched.map((r) => r.avgViewPct!));
    const change = held < 50 ? -5 : held >= 80 ? 5 : 0;
    const clip = Math.min(LONGEST_CLIP, Math.max(SHORTEST_CLIP, tuning.clipMaxSec + change));
    if (clip !== tuning.clipMaxSec) {
      next.clipMaxSec = clip;
      next.clipChangedAt = now;
      actions.push(`${change < 0 ? "Shortened" : "Lengthened"} new clips to at most ${clip} seconds: viewers watch ${Math.round(held)}% on average.`);
    }
  }

  const health: Health = judged.length < 5 ? "too-early" : reached.length / judged.length >= 0.3 ? "working" : reached.length ? "weak" : "not-reaching";
  const summary = {
    "too-early": `Only ${judged.length} posted Shorts are old enough to judge. Numbers take about 3 days.`,
    working: `${reached.length} of ${judged.length} Shorts reached the feed. This is working.`,
    weak: `Only ${reached.length} of ${judged.length} Shorts reached the feed.`,
    "not-reaching": `None of the last ${judged.length} Shorts reached the feed, so YouTube isn't showing them.`,
  }[health];

  const byCreator = new Map<string, { feedViews: number; posts: number }>();
  for (const r of judged) {
    if (!r.creator) continue;
    const c = byCreator.get(r.creator) ?? { feedViews: 0, posts: 0 };
    byCreator.set(r.creator, { feedViews: c.feedViews + r.feedViews, posts: c.posts + 1 });
  }
  const stayedRows = judged.filter((r) => r.stayed !== undefined && r.views > 0);
  const stayedViews = stayedRows.reduce((a, r) => a + r.views, 0);
  return {
    tuning: next,
    report: {
      at: now,
      health,
      summary,
      judged: judged.length,
      reachedFeed: reached.length,
      medianViews: median(judged.map((r) => r.views)),
      stayedToWatch: stayedViews ? stayedRows.reduce((a, r) => a + r.stayed! * r.views, 0) / stayedViews : undefined,
      bestCreators: [...byCreator].map(([creator, c]) => ({ creator, ...c })).sort((a, b) => b.feedViews - a.feedViews).slice(0, 3),
      focus: (() => {
        const mine = judged.filter((r) => r.creator && tuning.focusCreators?.includes(creatorName(r.creator)));
        const rest = judged.filter((r) => !mine.includes(r));
        if (mine.length < 5 || rest.length < 5) return undefined;
        return `Focus creators: ${mine.filter((r) => r.feedViews >= REACHED_FEED).length} of ${mine.length} reached the feed. Everyone else: ${rest.filter((r) => r.feedViews >= REACHED_FEED).length} of ${rest.length}.`;
      })(),
      actions,
      needsYou,
    },
  };
}
