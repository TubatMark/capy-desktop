/** Long-form compilations: shared between server and browser. No node imports here. */

export type LongStatus =
  | "draft"
  | "planning"
  | "narrating"
  | "rendering"
  | "checking"
  | "review"
  | "uploading"
  | "processing"
  | "private"
  | "scheduled"
  | "public"
  | "freed";

export type LongColumn = "draft" | "progress" | "review" | "uploading" | "scheduled" | "public" | "freed";

export const LONG_COLUMNS: { id: LongColumn; label: string; hint: string }[] = [
  { id: "draft", label: "Draft", hint: "Clips picked, not started" },
  { id: "progress", label: "In progress", hint: "Script, voice and edit" },
  { id: "review", label: "Ready for review", hint: "Waiting for you" },
  { id: "uploading", label: "Uploading", hint: "Sending to YouTube" },
  { id: "scheduled", label: "Scheduled", hint: "Private, or waiting for its slot" },
  { id: "public", label: "Public", hint: "Live on YouTube" },
  { id: "freed", label: "Space freed", hint: "Local files removed" },
];

const COLUMN: Record<LongStatus, LongColumn> = {
  draft: "draft",
  planning: "progress",
  narrating: "progress",
  rendering: "progress",
  checking: "progress",
  review: "review",
  uploading: "uploading",
  processing: "uploading",
  private: "scheduled",
  scheduled: "scheduled",
  public: "public",
  freed: "freed",
};
export const columnOf = (s: LongStatus): LongColumn => COLUMN[s];

export interface LongClip {
  jobId: string;
  n: number;
  /** Footage path relative to the output folder. */
  file: string;
  /** Where the footage file starts in the source video, seconds. */
  segStart: number;
  segEnd: number;
  /** The moment, in source-video seconds. */
  start: number;
  end: number;
  title: string;
  reason?: string;
  hook?: string;
  score: number;
  views?: number;
  channel: string;
  sourceTitle: string;
  sourceUrl: string;
  /** The narrator's line about this moment. */
  line?: string;
  /** Length after trimming, seconds. */
  seconds?: number;
}

export interface LongCheck {
  ok: boolean;
  duration: number;
  warnings: string[];
  script?: { verdict: "ok" | "caution"; notes: string[] };
}

export interface LongMetrics {
  at: number;
  ageHours: 48 | 168;
  views: number;
  philippinesViews: number;
}

export interface LongVideo {
  id: string;
  creator: string;
  status: LongStatus;
  /** What the worker is doing now. */
  step?: string;
  progress?: number;
  error?: string;
  /** The step Retry runs again. */
  failedStep?: LongWorkStep;
  failedIndex?: number;
  clips: LongClip[];
  title: string;
  thumbnailText?: string;
  intro?: string;
  outro?: string;
  description?: string;
  tags?: string[];
  /** Which voice read it, for telling the user when the fallback was used. */
  voice?: string;
  /** Relative to the output folder. */
  master?: string;
  thumb?: string;
  masterBytes?: number;
  check?: LongCheck;
  /** Unix ms the owner picked; public at this time. */
  slotAt?: number;
  slotId?: string;
  youtube?: {
    session?: string;
    offset?: number;
    size?: number;
    id?: string;
    processedAt?: number;
    publishedAt?: number;
    rejected?: string;
    note?: string;
    thumbnail?: "set" | "failed";
  };
  metrics?: LongMetrics[];
  freed?: { at: number; bytes: number; files: number };
  createdAt: number;
  updatedAt: number;
}

export type LongWorkStep = "plan" | "narrate" | "render" | "assemble" | "check" | "upload" | "observe";

/** Footage that hasn't gone into a long video yet. */
export interface CreatorFootage {
  creator: string;
  clips: number;
  rawSeconds: number;
  /** About how long a finished video could be. */
  estimateSeconds: number;
  enough: boolean;
}

export const MIN_LONG_SECONDS = 8 * 60;
export const TARGET_LONG_SECONDS = 15 * 60;
export const MAX_LONG_CLIPS = 15;
/** Trimming, and a narrated card before each clip. */
export const FINISHED_PER_RAW = 0.85;

// ---------- upload slots ----------

export interface UploadSlot {
  id: string;
  /** 0 = Sunday, in Philippine time. */
  day: number;
  hour: number;
  minute: number;
  label: string;
}

/** The starting test: see docs/superpowers/specs/2026-10-31-long-form-pipeline-plan.md. */
export const DEFAULT_SLOTS: UploadSlot[] = [
  { id: "sat-am", day: 6, hour: 9, minute: 0, label: "Saturday morning" },
  { id: "sun-am", day: 0, hour: 9, minute: 0, label: "Sunday morning" },
  { id: "fri-pm", day: 5, hour: 16, minute: 0, label: "Friday afternoon" },
];
const PHT_MS = 8 * 3600_000;
/** Enough time to upload and process before a video goes public. */
export const SLOT_LEAD_MS = 3 * 3600_000;
export const MAX_PER_WEEKEND = 2;
/** A slot isn't compared until it has this many results. */
export const RESULTS_TO_COMPARE = 3;

/** Unix ms of the next time this slot comes around after `after`. */
export function nextOccurrence(slot: Pick<UploadSlot, "day" | "hour" | "minute">, after: number): number {
  const local = new Date(after + PHT_MS);
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), slot.hour, slot.minute);
  const ahead = (slot.day - local.getUTCDay() + 7) % 7;
  let at = base + ahead * 86400_000 - PHT_MS;
  if (at <= after) at += 7 * 86400_000;
  return at;
}

/** Friday of the Philippine week this moment falls in: slots in one weekend share it. */
export function weekendKey(at: number): number {
  const local = new Date(at + PHT_MS);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // Friday=0, Saturday=1, Sunday=2 ... Thursday=6
  return day - ((local.getUTCDay() + 2) % 7) * 86400_000;
}

/**
 * The next slot to use: the soonest open one, preferring slots with the fewest results so all of them get tried,
 * with at most MAX_PER_WEEKEND videos a weekend. Ties go to the order the slots are listed in.
 */
export function recommendSlot(
  slots: UploadSlot[],
  taken: { at: number; slotId?: string }[],
  now: number,
): { slot: UploadSlot; at: number } | null {
  if (!slots.length) return null;
  const used = (id: string) => taken.filter((t) => t.slotId === id).length;
  const perWeekend = new Map<number, number>();
  for (const t of taken) perWeekend.set(weekendKey(t.at), (perWeekend.get(weekendKey(t.at)) ?? 0) + 1);
  const options: { slot: UploadSlot; at: number; used: number; order: number }[] = [];
  slots.forEach((slot, order) => {
    let at = nextOccurrence(slot, now + SLOT_LEAD_MS);
    for (let i = 0; i < 52; i++) {
      const clash = taken.some((t) => Math.abs(t.at - at) < 3600_000);
      if (!clash && (perWeekend.get(weekendKey(at)) ?? 0) < MAX_PER_WEEKEND) break;
      at += 7 * 86400_000;
    }
    options.push({ slot, at, used: used(slot.id), order });
  });
  options.sort((a, b) => a.used - b.used || a.at - b.at || a.order - b.order);
  const pick = options[0]!;
  return { slot: pick.slot, at: pick.at };
}

const fmt = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
export const philippineTime = (at: number) => `${fmt(at, "Asia/Manila")} PHT`;
export const easternTime = (at: number) => `${fmt(at, "America/New_York")} ET`;

// ---------- results per slot ----------

export interface SlotResult {
  slotId: string;
  videos: number;
  avgViews: number;
  avgPhilippinesViews: number;
  /** Enough videos to compare yet? */
  comparable: boolean;
}

/** Views a week after publishing, averaged per slot. */
export function slotResults(slots: UploadSlot[], videos: Pick<LongVideo, "slotId" | "metrics">[]): SlotResult[] {
  return slots.map((slot) => {
    const week = videos.filter((v) => v.slotId === slot.id).flatMap((v) => v.metrics?.filter((m) => m.ageHours === 168) ?? []);
    const avg = (f: (m: LongMetrics) => number) => (week.length ? Math.round(week.reduce((a, m) => a + f(m), 0) / week.length) : 0);
    return {
      slotId: slot.id,
      videos: week.length,
      avgViews: avg((m) => m.views),
      avgPhilippinesViews: avg((m) => m.philippinesViews),
      comparable: week.length >= RESULTS_TO_COMPARE,
    };
  });
}

// ---------- audience ----------

export interface AudienceReport {
  fetchedAt: number;
  countries: { country: string; views: number; avgViewPct: number }[];
  ageGender: { group: string; gender: string; pct: number }[];
  philippinesAgeGender: { group: string; gender: string; pct: number }[];
  totalViews: number;
}

// ---------- ranking ----------

/** AI scores bunch up at 7-9, so real views separate them: each tenfold rise in views is worth half a point, up to 2. */
export function rankValue(c: Pick<LongClip, "score" | "views">): number {
  const boost = c.views && c.views > 0 ? Math.min(2, Math.log10(c.views + 1) / 2) : 0;
  return c.score + boost;
}

/** Same creators under two channel names count as one person. */
export function creatorName(channel: string): string {
  const name = channel.replace(/\s+live$/i, "").replace(/^live\s+/i, "").trim();
  return /^(i?show\s*speed|speedy)$/i.test(name) ? "IShowSpeed" : name.toUpperCase() === "RAY" ? "Ray" : name;
}

export const formatLength = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
