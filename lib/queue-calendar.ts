import type { QueueEntry } from "./types";
import { queueGroup } from "./queue-source";
import type { MetricObservation, PerformancePublication } from "./performance";

/**
 * Calendar helpers for the Queue page. Every day boundary is taken in ONE time
 * zone (the posting audience's), so a post at 11:30 pm New York time sits on the
 * New York day even when this computer is somewhere else.
 */

/** "YYYY-MM-DD" of the instant `at` (Unix ms) as a wall-clock date in `tz`. */
export function dayKey(at: number, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

export interface DayParts {
  y: number;
  /** 1–12 */
  m: number;
  d: number;
}
export const parseDay = (key: string): DayParts => {
  const [y, m, d] = key.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
};
const pad = (n: number) => String(n).padStart(2, "0");
export const toDayKey = ({ y, m, d }: DayParts) => `${y}-${pad(m)}-${pad(d)}`;

/** Calendar arithmetic on plain dates (no time zone involved): `key` moved by `days`. */
export function addDays(key: string, days: number): string {
  const { y, m, d } = parseDay(key);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return toDayKey({
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
  });
}
/** Same day-of-month `months` later, clamped to the month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(key: string, months: number): string {
  const { y, m, d } = parseDay(key);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return toDayKey({
    y: first.getUTCFullYear(),
    m: first.getUTCMonth() + 1,
    d: Math.min(d, last),
  });
}
/** 0 = Sunday. */
export const weekday = (key: string) => {
  const { y, m, d } = parseDay(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
export const monthOf = (key: string) => key.slice(0, 7);

/** Whole weeks (Sunday first) covering the month that contains `key`. */
export function monthGrid(key: string): string[][] {
  const { y, m } = parseDay(key);
  const first = toDayKey({ y, m, d: 1 });
  let day = addDays(first, -weekday(first));
  const weeks: string[][] = [];
  do {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  } while (monthOf(day) === monthOf(first));
  return weeks;
}

/** Format a plain day key without letting the browser's zone shift it. */
export function fmtDay(
  key: string,
  opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
  },
) {
  const { y, m, d } = parseDay(key);
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
}

export type PostKind = "posted" | "scheduled" | "attention";

/** Where one platform's post stands, in three buckets the calendar can show. */
export function entryKind(e: QueueEntry): PostKind | undefined {
  if (e.status === "review" || e.status === "rejected") return undefined;
  if (e.status === "posted" || e.delivery?.state === "public") return "posted";
  if (e.status === "failed" || e.status === "needs_action") return "attention";
  return "scheduled";
}

/** When this post went (or goes) out: the live time YouTube reported, else the planned slot. */
export function entryTime(e: QueueEntry): number {
  return (
    e.delivery?.publishedAt ??
    e.delivery?.firstPublicAt ??
    (e.status !== "posted" ? e.remoteSchedule?.publishAt : undefined) ??
    e.slotAt ??
    e.updatedAt
  );
}

/** One clip on one day: its platform entries that fall on that day. */
export interface DayPost {
  group: string;
  entries: QueueEntry[];
  at: number;
  kind: PostKind;
}

/** Something wrong beats something pending beats done. */
const RANK: Record<PostKind, number> = {
  attention: 0,
  scheduled: 1,
  posted: 2,
};
export const postKind = (entries: QueueEntry[]): PostKind =>
  entries
    .map(entryKind)
    .filter((k): k is PostKind => !!k)
    .sort((a, b) => RANK[a] - RANK[b])[0] ?? "scheduled";

/** Scheduled and posted clips by audience-time day, each day sorted by time. */
export function bucketByDay(
  entries: QueueEntry[],
  tz: string,
): Map<string, DayPost[]> {
  const days = new Map<string, Map<string, QueueEntry[]>>();
  for (const e of entries) {
    if (!entryKind(e)) continue;
    const day = dayKey(entryTime(e), tz);
    const groups = days.get(day) ?? new Map<string, QueueEntry[]>();
    const g = queueGroup(e);
    groups.set(g, [...(groups.get(g) ?? []), e]);
    days.set(day, groups);
  }
  const out = new Map<string, DayPost[]>();
  for (const [day, groups] of days)
    out.set(
      day,
      [...groups.entries()]
        .map(([group, es]) => ({
          group,
          entries: es,
          at: Math.min(...es.map(entryTime)),
          kind: postKind(es),
        }))
        .sort((a, b) => a.at - b.at),
    );
  return out;
}

export type DayCounts = Record<PostKind, number>;
export function countKinds(posts: DayPost[] = []): DayCounts {
  const c: DayCounts = { posted: 0, scheduled: 0, attention: 0 };
  for (const p of posts) c[p.kind]++;
  return c;
}

/** The nearest day after (dir 1) or before (dir -1) `from` that has posts. */
export function nearestDay(
  days: Iterable<string>,
  from: string,
  dir: 1 | -1,
): string | undefined {
  let best: string | undefined;
  for (const d of days)
    if (
      (dir === 1 ? d > from : d < from) &&
      (!best || (dir === 1 ? d < best : d > best))
    )
      best = d;
  return best;
}

/**
 * The picture shown for a post. Today that is the clip's frame (`thumbUrl`);
 * point this at a designed thumbnail once queue entries carry one.
 */
export function postThumb(entries: QueueEntry[]): string | undefined {
  return entries.find((e) => e.thumbUrl)?.thumbUrl;
}

/** Results recorded for this post: matched by its delivery record, else by the YouTube video id. */
export function publicationsFor(
  entries: QueueEntry[],
  publications: PerformancePublication[] = [],
): PerformancePublication[] {
  const deliveries = new Set(
    entries.map((e) => e.delivery?.id).filter(Boolean),
  );
  const remote = new Set(
    entries.flatMap((e) =>
      [e.result?.id, ...(e.delivery?.publicationIds ?? [])].filter(Boolean),
    ),
  );
  return publications.filter(
    (p) =>
      deliveries.has(p.delivery.id) || (!!p.remoteId && remote.has(p.remoteId)),
  );
}

/** A metric's number for display: the current value, else the last one seen (marked as older). */
export function metricValue(
  m: MetricObservation | undefined,
): { value: number; unit: string; stale: boolean } | undefined {
  if (!m) return undefined;
  if (m.availability === "available")
    return { value: m.value, unit: m.unit, stale: false };
  if (m.lastAvailable)
    return {
      value: m.lastAvailable.value,
      unit: m.lastAvailable.unit,
      stale: true,
    };
  return undefined;
}

/** Why a number is missing, in words a creator would use. */
export function missingReason(m: MetricObservation | undefined): string {
  if (!m || m.availability === "available") return "Not available yet";
  switch (m.reason) {
    case "not-published":
      return "Not live yet";
    case "not-refreshed":
    case "expired":
      return "Not checked yet";
    case "delayed-or-limited":
    case "not-returned":
      return "YouTube hasn't shared this yet";
    case "auth-required":
    case "scope-missing":
      return "Reconnect YouTube to see this";
    case "not-supported":
      return "Only shown for YouTube for now";
    case "destination-changed":
      return "A different channel is connected";
    default:
      return "Couldn't check right now";
  }
}
