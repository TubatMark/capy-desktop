import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { allocateSlot, fmtIn } from "../lib/post-time";
import type { Platform, PostText, QueueEntry, QueueSummary } from "../lib/types";
import { postTextFor, type Publish } from "./platforms/text";
import type { PostOutcome } from "./platforms/types";
import { dataDir } from "./settings";

/**
 * The posting queue: one entry per clip × platform in <CAPY_DATA_DIR>/queue.json.
 * Rendered clips enter as "review"; only an approval gives them a slot. Every transition is a pure
 * function over the entry list (tested directly); queue().mutate applies one and saves.
 */

export interface ClipInfo {
  jobId: string;
  n: number;
  clipTitle: string;
  videoTitle?: string;
  videoUrl?: string;
  thumbUrl?: string;
  thumbAt?: number;
  publish?: Publish;
  hook?: string;
}

const MIN = 60_000;
const LATE_MS = 2 * 60 * MIN;
const BACKOFF_MIN = [2, 10, 30];

export const keyOf = (jobId: string, n: number, p: Platform) => `${jobId}:${n}:${p}`;

export function note(e: QueueEntry, msg: string, now: Date): QueueEntry {
  return { ...e, history: [...e.history, { t: now.getTime(), msg }].slice(-50), updatedAt: now.getTime() };
}

export function patch(entries: QueueEntry[], key: string, fn: (e: QueueEntry) => QueueEntry): QueueEntry[] {
  return entries.map((e) => (e.key === key ? fn(e) : e));
}

/** A clip finished rendering: add review entries, or refresh the media of ones still waiting to post. */
export function upsertForRender(entries: QueueEntry[], c: ClipInfo, platforms: Platform[], now: Date): QueueEntry[] {
  const out = [...entries];
  const publish = c.publish ?? { ytTitle: c.clipTitle, description: "", hashtags: [] };
  for (const p of platforms) {
    const key = keyOf(c.jobId, c.n, p);
    const i = out.findIndex((e) => e.key === key);
    const media = { videoUrl: c.videoUrl, thumbUrl: c.thumbUrl, thumbAt: c.thumbAt, clipTitle: c.clipTitle, videoTitle: c.videoTitle };
    if (i < 0) {
      out.push(note({ key, jobId: c.jobId, n: c.n, platform: p, status: "review", ...media, text: postTextFor(p, publish, c.hook), attempts: 0, history: [], createdAt: now.getTime(), updatedAt: now.getTime() }, "Rendered, waiting for your OK", now));
      continue;
    }
    const e = out[i]!;
    // already out, on its way out, or turned down: a re-render doesn't touch it
    if (e.status === "posted" || e.status === "posting" || e.status === "rejected") continue;
    out[i] = note({ ...e, ...media }, "Re-rendered, will post the new version", now);
  }
  return out;
}

/** Scheduled/posting entries, plus posts from the last 24h, as slot-allocator input. */
function taken(entries: QueueEntry[], now: Date, except?: (e: QueueEntry) => boolean) {
  return entries
    .filter((e) => !except?.(e))
    .filter((e) => ((e.status === "scheduled" || e.status === "posting") && e.slotAt !== undefined) || (e.status === "posted" && now.getTime() - (e.slotAt ?? e.updatedAt) < 24 * 60 * MIN))
    .map((e) => ({ platform: e.platform, at: e.slotAt ?? e.updatedAt }));
}

/** Approve one clip (n) or every clip of a video waiting for review; each clip gets one shared slot. */
export function approve(entries: QueueEntry[], jobId: string, n: number | undefined, o: { platforms?: Platform[]; audienceTz: string; now: Date }): { entries: QueueEntry[]; scheduled: QueueEntry[] } {
  let out = [...entries];
  const ns = [...new Set(out.filter((e) => e.jobId === jobId && e.status === "review" && (n === undefined || e.n === n)).map((e) => e.n))].sort((a, b) => a - b);
  const scheduled: QueueEntry[] = [];
  for (const cn of ns) {
    const mine = out.filter((e) => e.jobId === jobId && e.n === cn && e.status === "review");
    const chosen = mine.filter((e) => !o.platforms || o.platforms.includes(e.platform));
    for (const e of mine) if (!chosen.includes(e)) out = patch(out, e.key, (x) => note({ ...x, status: "rejected" }, "Not chosen at approval", o.now));
    if (!chosen.length) continue;
    const slot = allocateSlot(taken(out, o.now), chosen.map((e) => e.platform), o.audienceTz, o.now);
    for (const e of chosen) {
      out = patch(out, e.key, (x) =>
        slot ? note({ ...x, status: "scheduled", slotAt: slot.getTime(), attempts: 0, error: undefined }, `Approved for ${fmtIn(slot, o.audienceTz)}`, o.now) : note(x, "No free slot in the next 14 days", o.now),
      );
      if (slot) scheduled.push(out.find((x) => x.key === e.key)!);
    }
  }
  return { entries: out, scheduled };
}

export const reject = (entries: QueueEntry[], key: string, now: Date) => patch(entries, key, (e) => note({ ...e, status: "rejected", slotAt: undefined }, "Rejected", now));

export const remove = (entries: QueueEntry[], key: string) => entries.filter((e) => e.key !== key);

export const editText = (entries: QueueEntry[], key: string, text: PostText, now: Date) => patch(entries, key, (e) => ({ ...e, text: { ...e.text, ...text }, updatedAt: now.getTime() }));

export const move = (entries: QueueEntry[], key: string, slotAt: number, now: Date, tz: string) =>
  patch(entries, key, (e) => note({ ...e, status: "scheduled", slotAt, nextTryAt: undefined }, `Moved to ${fmtIn(new Date(slotAt), tz)}`, now));

export const postNow = (entries: QueueEntry[], key: string, now: Date) => patch(entries, key, (e) => note({ ...e, status: "scheduled", slotAt: now.getTime(), nextTryAt: undefined }, "Post now", now));

export const retry = (entries: QueueEntry[], key: string, now: Date) =>
  patch(entries, key, (e) => note({ ...e, status: "scheduled", slotAt: now.getTime(), attempts: 0, nextTryAt: undefined, error: undefined, authBlocked: false }, "Retry", now));

/** Slots that passed while capy wasn't running: under 2h late still post; later ones move to a new slot. */
export function reconcileMissed(entries: QueueEntry[], audienceTz: string, now: Date): QueueEntry[] {
  let out = [...entries];
  const late = out.filter((e) => e.status === "scheduled" && e.slotAt !== undefined && now.getTime() - e.slotAt > LATE_MS);
  const groups = new Map<string, QueueEntry[]>();
  for (const e of late) groups.set(`${e.jobId}:${e.n}`, [...(groups.get(`${e.jobId}:${e.n}`) ?? []), e]);
  for (const group of groups.values()) {
    const keys = new Set(group.map((e) => e.key));
    const slot = allocateSlot(taken(out, now, (e) => keys.has(e.key)), group.map((e) => e.platform), audienceTz, now);
    for (const e of group) {
      out = patch(out, e.key, (x) =>
        slot
          ? note({ ...x, slotAt: slot.getTime() }, `Missed ${fmtIn(new Date(x.slotAt!), audienceTz)} (the computer was asleep or capy was closed), moved to ${fmtIn(slot, audienceTz)}`, now)
          : note({ ...x, slotAt: now.getTime() }, "Missed its slot and no free slot is left, posting now", now),
      );
    }
  }
  return out;
}

/** On startup: anything that was mid-upload when capy stopped gets posted again. */
export function recoverInterrupted(entries: QueueEntry[], now: Date): QueueEntry[] {
  return entries.map((e) => (e.status === "posting" ? note({ ...e, status: "scheduled", slotAt: now.getTime() }, "Interrupted, retrying", now) : e));
}

export type PostResult = { outcome: PostOutcome } | { error: { message: string; retryable: boolean; auth: boolean } };

export function markResult(entries: QueueEntry[], key: string, r: PostResult, now: Date): QueueEntry[] {
  return patch(entries, key, (e) => {
    if ("outcome" in r) {
      const { id, url, note: n } = r.outcome;
      const result = { id, url, note: n };
      return r.outcome.kind === "posted"
        ? note({ ...e, status: "posted", result, error: undefined, nextTryAt: undefined }, n ? `Posted. ${n}` : "Posted", now)
        : note({ ...e, status: "needs_action", result, error: undefined, nextTryAt: undefined }, r.outcome.note, now);
    }
    const { message, retryable, auth } = r.error;
    if (auth) return note({ ...e, status: "needs_action", authBlocked: true, error: message, nextTryAt: undefined }, message, now);
    const attempts = e.attempts + 1;
    const wait = retryable ? BACKOFF_MIN[attempts - 1] : undefined;
    return note(
      { ...e, status: "failed", attempts, error: message, nextTryAt: wait !== undefined ? now.getTime() + wait * MIN : undefined },
      wait !== undefined ? `${message} (retrying in ${wait} min)` : message,
      now,
    );
  });
}

/** An account was reconnected: its entries that were waiting on it go back on the schedule. */
export function reconnected(entries: QueueEntry[], platform: Platform, audienceTz: string, now: Date): QueueEntry[] {
  let out = [...entries];
  for (const e of out.filter((x) => x.platform === platform && x.authBlocked)) {
    const keep = e.slotAt !== undefined && e.slotAt > now.getTime();
    const slot = keep ? new Date(e.slotAt!) : allocateSlot(taken(out, now, (x) => x.key === e.key), [platform], audienceTz, now);
    out = patch(out, e.key, (x) => note({ ...x, status: "scheduled", authBlocked: false, error: undefined, slotAt: (slot ?? now).getTime() }, "Account reconnected", now));
  }
  return out;
}

export function summary(entries: QueueEntry[], now: Date): QueueSummary {
  const active = entries.filter((e) => e.status === "scheduled" || e.status === "posting");
  const next = active.filter((e) => e.slotAt !== undefined).sort((a, b) => a.slotAt! - b.slotAt!)[0];
  void now;
  return {
    review: new Set(entries.filter((e) => e.status === "review").map((e) => `${e.jobId}:${e.n}`)).size,
    activeCount: active.length,
    nextPost: next ? { at: next.slotAt!, platforms: active.filter((e) => e.slotAt === next.slotAt).map((e) => e.platform) } : undefined,
  };
}

// ---------- store ----------

declare global {
  // eslint-disable-next-line no-var
  var __capyQueue: { file: string; mtime: number; entries: QueueEntry[] } | null | undefined;
}

export function resetQueueCache() {
  globalThis.__capyQueue = null;
}

const queueFile = () => path.join(dataDir(), "queue.json");
const mtimeOf = (f: string) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

function load(): QueueEntry[] {
  const file = queueFile();
  const c = globalThis.__capyQueue;
  if (c && c.file === file && c.mtime === mtimeOf(file)) return c.entries;
  let entries: QueueEntry[] = [];
  try {
    entries = JSON.parse(readFileSync(file, "utf8")) as QueueEntry[];
  } catch {
    /* empty queue */
  }
  // first load in this process: nothing can be uploading yet
  if (!c || c.file !== file) entries = recoverInterrupted(entries, new Date());
  globalThis.__capyQueue = { file, mtime: mtimeOf(file), entries };
  return entries;
}

function save(entries: QueueEntry[]) {
  const file = queueFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
  renameSync(tmp, file);
  globalThis.__capyQueue = { file, mtime: mtimeOf(file), entries };
}

/** The queue store. `mutate` is synchronous, so two callers can never interleave a read-modify-write. */
export function queue() {
  return {
    list: () => load(),
    mutate(fn: (e: QueueEntry[]) => QueueEntry[]): QueueEntry[] {
      const next = fn(load());
      save(next);
      return next;
    },
  };
}
