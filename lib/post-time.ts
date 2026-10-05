/**
 * "Best time to post" for a Short. Rule-based from published Shorts timing studies
 * (Buffer 1.8M videos: evenings 6–11pm local, Fri/Sat/Thu strongest, Mon/Tue weakest;
 * FlowShorts/Adobe/Sprout: weekday 2–6pm ET). Times are in the AUDIENCE's local
 * time; we post ~1h before the peak so the Short is live when viewers arrive.
 * YouTube's own "When your viewers are on YouTube" chart beats any generic table —
 * this is the sensible default until the channel has that data.
 */

import type { Platform } from "./types";

export interface Audience {
  id: string;
  label: string;
  tz: string;
}

export const AUDIENCES: Audience[] = [
  { id: "us-east", label: "United States (East)", tz: "America/New_York" },
  { id: "us-west", label: "United States (West)", tz: "America/Los_Angeles" },
  { id: "ph", label: "Philippines", tz: "Asia/Manila" },
  { id: "uk", label: "United Kingdom", tz: "Europe/London" },
  { id: "br", label: "Brazil", tz: "America/Sao_Paulo" },
  { id: "in", label: "India", tz: "Asia/Kolkata" },
  { id: "au", label: "Australia (East)", tz: "Australia/Sydney" },
];

/** Posting hours (audience local, 24h) per weekday, best first. 0 = Sunday. */
const SLOTS: Record<number, number[]> = {
  5: [17, 15, 19], // Fri: strongest day
  4: [17, 15, 19], // Thu
  6: [16, 11, 19], // Sat: late morning + evening
  3: [16, 15, 18], // Wed
  0: [12, 16, 19], // Sun: midday + evening
  2: [15, 18], // Tue: weaker, mid-afternoon
  1: [15, 18], // Mon: weakest
};
const DAY_RANK = [5, 4, 6, 3, 0, 2, 1]; // for "best overall"

export interface Slot {
  /** UTC instant */
  at: Date;
  score: number; // 100 = best
  audienceLocal: string;
  utc: string;
  yourLocal: string;
  dayName: string;
  reason: string;
}

/** Local wall-clock parts of `d` in `tz`. */
function partsIn(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p: Record<string, string> = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour! % 24, min: +p.minute!, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!) };
}

/** UTC Date for a wall-clock time in `tz` (iterative offset fix handles DST). */
function fromZoned(y: number, m: number, d: number, h: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, m - 1, d, h, 0, 0));
  for (let i = 0; i < 2; i++) {
    const p = partsIn(guess, tz);
    const diff = Date.UTC(y, m - 1, d, h) - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

function fmt(d: Date, tz: string, withDay = true) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: withDay ? "short" : undefined, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}

/** Next `count` recommended posting times after `now`, best first. */
export function bestPostTimes(audienceTz: string, yourTz: string, now = new Date(), count = 3, horizonDays = 8): Slot[] {
  const out: Slot[] = [];
  const start = partsIn(now, audienceTz);
  for (let dayOff = 0; dayOff < horizonDays; dayOff++) {
    const dayDate = new Date(Date.UTC(start.y, start.m - 1, start.d + dayOff, 12));
    const p = partsIn(dayDate, audienceTz);
    const hours = SLOTS[p.wd] ?? [17];
    hours.forEach((h, rank) => {
      const at = fromZoned(p.y, p.m, p.d, h, audienceTz);
      if (at.getTime() < now.getTime() + 30 * 60 * 1000) return; // must be at least 30 min away
      const dayScore = 100 - DAY_RANK.indexOf(p.wd) * 9; // Fri 100 … Mon 46
      const slotScore = dayScore - rank * 6 - dayOff * 1.5; // sooner is slightly better
      const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][p.wd]!;
      out.push({
        at,
        score: Math.round(slotScore),
        dayName,
        audienceLocal: fmt(at, audienceTz),
        utc: fmt(at, "UTC"),
        yourLocal: fmt(at, yourTz),
        reason: reasonFor(p.wd, h),
      });
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, count);
}

function reasonFor(wd: number, h: number) {
  const day = wd === 5 ? "Friday is the strongest day for Shorts" : wd === 4 || wd === 6 ? "Thu/Sat are the next-best days" : wd === 1 || wd === 2 ? "Mon/Tue are the quietest days" : "solid mid-week slot";
  const when = h >= 17 ? "live before the 6–11pm evening peak" : h >= 15 ? "catches the after-school/work scroll" : "late-morning weekend browsing";
  return `${day}; ${when}.`;
}

/** Audience id → tz, with a sane default for English-speaking creator content. */
export function audienceTz(id?: string) {
  return AUDIENCES.find((a) => a.id === (id ?? "us-east"))?.tz ?? "America/New_York";
}

/** Candidate posting hours per weekday (audience local); each day has two at least 4h apart. 0 = Sunday. */
export const CANDIDATE_HOURS: Record<number, number[]> = {
  5: [17, 15, 19, 12],
  4: [17, 15, 19, 12],
  6: [16, 11, 19, 20],
  3: [16, 12, 20, 15],
  0: [12, 16, 19, 20],
  2: [15, 11, 19, 18],
  1: [15, 11, 19, 18],
};
const GAP_MS = 4 * 3_600_000;
const PER_DAY = 2;

/**
 * Earliest good slot (at least 30 min away) where every platform has fewer than 2 posts that
 * audience-local day and none within 4h. `taken` holds scheduled, posting and recently posted entries.
 */
export function allocateSlot(taken: { platform: Platform; at: number }[], platforms: Platform[], audienceTz: string, now = new Date(), horizonDays = 14): Date | null {
  const dayKey = (t: number) => {
    const p = partsIn(new Date(t), audienceTz);
    return `${p.y}-${p.m}-${p.d}`;
  };
  const start = partsIn(now, audienceTz);
  for (let off = 0; off < horizonDays; off++) {
    const p = partsIn(new Date(Date.UTC(start.y, start.m - 1, start.d + off, 12)), audienceTz);
    const cands = (CANDIDATE_HOURS[p.wd] ?? [17])
      .map((h) => ({ h, at: fromZoned(p.y, p.m, p.d, h, audienceTz) }))
      .filter(({ h, at }) => partsIn(at, audienceTz).h === h) // an hour skipped by DST doesn't exist
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const { at } of cands) {
      const t = at.getTime();
      if (t < now.getTime() + 30 * 60_000) continue;
      const free = platforms.every((pl) => {
        const mine = taken.filter((x) => x.platform === pl);
        return mine.filter((x) => dayKey(x.at) === dayKey(t)).length < PER_DAY && mine.every((x) => Math.abs(x.at - t) >= GAP_MS);
      });
      if (free) return at;
    }
  }
  return null;
}

/** UTC instant of a wall-clock time in `tz` (for the queue's "Move" picker). */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  return new Date(fromZoned(y, m, d, h, tz).getTime() + min * 60_000);
}

export { fmt as fmtIn };
