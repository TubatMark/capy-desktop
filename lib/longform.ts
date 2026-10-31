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
  { id: "review", label: "Reviewed", hint: "AI checks done, next upload is automatic" },
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

/** Not every video looks the same: YouTube doesn't count template-based bulk changes as adding anything. */
export type LongFormat = "countdown" | "tier" | "awards";
export const LONG_FORMATS: LongFormat[] = ["countdown", "tier", "awards"];

/** The format used longest ago, so a run of videos doesn't repeat one. */
export function nextFormat(videos: Pick<LongVideo, "format" | "createdAt">[]): LongFormat {
  const last = (f: LongFormat) => Math.max(0, ...videos.filter((v) => (v.format ?? "countdown") === f).map((v) => v.createdAt));
  return [...LONG_FORMATS].sort((a, b) => last(a) - last(b))[0]!;
}

/** What goes on the card: "#3", "S tier", or an award's name. `rank` 1 is the best of `total`. */
export function badgeFor(format: LongFormat | undefined, rank: number, total: number, label?: string): string {
  if (format === "tier") return rank <= Math.ceil(total * 0.2) ? "S tier" : rank <= Math.ceil(total * 0.5) ? "A tier" : "B tier";
  if (format === "awards" && label?.trim()) return label.trim();
  return `#${rank}`;
}

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
  /** This moment's award, for the awards format. */
  label?: string;
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
  /** Share of the video watched on average, 0-100. */
  avgViewPct?: number;
  avgViewSeconds?: number;
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
  /** How many times the autopilot has retried a failure. */
  autoRetries?: number;
  /** The script has had its one automatic rewrite. */
  fixTried?: boolean;
  uploadStartedAt?: number;
  clips: LongClip[];
  format?: LongFormat;
  /** Other titles and thumbnails, ready for YouTube Studio's A/B test. */
  titleOptions?: string[];
  thumbOptions?: string[];
  /** Moments the screening left out of this video, for the owner to see. */
  screenedOut?: { title: string; why: string }[];
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
/** Every slot can be used: stream moments lose interest, so videos shouldn't queue for weeks. */
export const MAX_PER_WEEKEND = 3;
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

// ---------- autopilot ----------

export interface AutopilotSettings {
  /** Check footage and draft videos. */
  draft: boolean;
  /** Upload a video that passed every check, as Private. */
  upload: boolean;
  /** Give Private videos a public time. */
  publish: boolean;
  /** Delete local files once a video's hold has passed. */
  free: boolean;
}
export const DEFAULT_AUTOPILOT: AutopilotSettings = { draft: true, upload: true, publish: true, free: false };

/** Don't pile up more finished videos than anyone can watch. */
export const MAX_WAITING_VIDEOS = 6;
/** A video upload costs about a sixth of YouTube's daily quota, and Shorts need the rest. */
export const AUTO_UPLOAD_GAP_MS = 20 * 3600_000;
/** Time for claims to appear after processing, and for the owner to look, before a video goes public. */
export const PUBLISH_HOLD_MS = 6 * 3600_000;
/** Local files outlast that by far: they're the only way to fix and upload a video again. */
export const AUTO_HOLD_MS = 48 * 3600_000;
const MAX_AUTO_RETRIES = 1;
/** Several failures in a row usually share a cause: stop spending AI and wait for the owner. */
const MAX_FAILED_VIDEOS = 2;

export interface AutopilotLogEntry {
  at: number;
  text: string;
}

export type AutopilotAction =
  | { kind: "retry"; id: string }
  | { kind: "fix"; id: string }
  | { kind: "draft"; creator: string }
  | { kind: "upload"; id: string }
  | { kind: "publish"; id: string }
  | { kind: "free"; id: string };

const WORKING: LongStatus[] = ["draft", "planning", "narrating", "rendering", "checking"];

/** What the autopilot should do now. Pure, so every rule is testable. */
export function autopilotActions(videos: LongVideo[], footage: CreatorFootage[], s: AutopilotSettings, now: number): AutopilotAction[] {
  const out: AutopilotAction[] = [];
  const failed = videos.filter((v) => v.error && !v.youtube?.rejected);
  for (const v of failed) if (v.failedStep && (v.autoRetries ?? 0) < MAX_AUTO_RETRIES) out.push({ kind: "retry", id: v.id });

  const working = videos.some((v) => WORKING.includes(v.status) && !v.error);
  // made before the review could fix its own notes, or the review ran late: run the script again before it goes anywhere
  const unfixed = videos.filter((v) => v.status === "review" && v.check && !v.check.ok && !v.check.warnings?.length && !v.fixTried && !v.error).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (unfixed && !working && !out.length) out.push({ kind: "fix", id: unfixed.id });
  const waiting = videos.filter((v) => v.status === "review").length;
  if (s.draft && !working && !out.length && failed.length < MAX_FAILED_VIDEOS && waiting < MAX_WAITING_VIDEOS) {
    const blocked = new Set(failed.map((v) => v.creator));
    const lastVideo = (creator: string) => Math.max(0, ...videos.filter((v) => v.creator === creator).map((v) => v.createdAt));
    const next = footage
      .filter((f) => f.enough && !blocked.has(f.creator))
      .sort((a, b) => lastVideo(a.creator) - lastVideo(b.creator) || b.rawSeconds - a.rawSeconds)[0];
    if (next) out.push({ kind: "draft", creator: next.creator });
  }

  const uploading = videos.some((v) => v.status === "uploading" && !v.error);
  const lastUpload = Math.max(0, ...videos.map((v) => v.uploadStartedAt ?? 0));
  if (s.upload && !uploading && now - lastUpload >= AUTO_UPLOAD_GAP_MS) {
    // a script keeps the review's remaining notes after its one rewrite (reviewers rarely find nothing); a broken file waits for the owner
    const ready = videos.filter((v) => v.status === "review" && v.master && v.check && !v.check.warnings?.length && (v.check.ok || v.fixTried) && !v.error).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (ready) out.push({ kind: "upload", id: ready.id });
  }

  const held = (v: LongVideo, ms: number) => !!v.youtube?.id && !v.youtube.rejected && !!v.youtube.processedAt && now - v.youtube.processedAt >= ms;
  if (s.publish) {
    const next = videos.filter((v) => v.status === "private" && !v.slotAt && !v.check?.warnings?.length && held(v, PUBLISH_HOLD_MS)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next) out.push({ kind: "publish", id: next.id });
  }
  if (s.free) for (const v of videos) if (v.status !== "freed" && held(v, AUTO_HOLD_MS) && !v.error) out.push({ kind: "free", id: v.id });
  return out;
}

export function describeAction(a: AutopilotAction, title?: string): string {
  switch (a.kind) {
    case "retry":
      return `Tried "${title}" again after a failure`;
    case "fix":
      return `Rewriting the script of "${title}" to fix the review's notes`;
    case "draft":
      return `Started a new ${a.creator} video`;
    case "upload":
      return `Started uploading "${title}" as Private`;
    case "publish":
      return `Scheduled "${title}" to go public`;
    case "free":
      return `Freed the local files of "${title}"`;
  }
}

// ---------- when each video goes live ----------

export interface LiveTime {
  at: number;
  /** Booked on YouTube, or live already. Otherwise it's capy's projection. */
  booked: boolean;
  /** A file problem (black frames, no sound) keeps a video back until the owner looks. */
  needsOwner?: boolean;
}

/**
 * When each video goes live: the real time once booked, otherwise a projection from the one-a-day uploads, the 48-hour
 * hold and the next open slots, oldest video first so the dates don't overlap.
 */
export function liveTimes(videos: LongVideo[], slots: UploadSlot[], now: number): Record<string, LiveTime> {
  const out: Record<string, LiveTime> = {};
  const taken: { at: number; slotId?: string }[] = [];
  for (const v of videos) {
    const at = v.youtube?.publishedAt ?? v.slotAt;
    if (at) {
      out[v.id] = { at, booked: true };
      if (v.slotAt) taken.push({ at: v.slotAt, slotId: v.slotId });
    }
  }
  let nextUpload = Math.max(now, Math.max(0, ...videos.map((v) => v.uploadStartedAt ?? 0)) + AUTO_UPLOAD_GAP_MS);
  for (const v of [...videos].sort((a, b) => a.createdAt - b.createdAt)) {
    if (out[v.id] || v.error || v.youtube?.rejected || v.status === "public") continue;
    let onYouTube = v.youtube?.processedAt ?? v.uploadStartedAt;
    if (!onYouTube) {
      onYouTube = nextUpload;
      nextUpload += AUTO_UPLOAD_GAP_MS;
    }
    const pick = recommendSlot(slots, taken, Math.max(now, onYouTube + PUBLISH_HOLD_MS));
    if (!pick) continue;
    taken.push({ at: pick.at, slotId: pick.slot.id });
    out[v.id] = { at: pick.at, booked: false, needsOwner: !!v.check?.warnings?.length };
  }
  return out;
}

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
