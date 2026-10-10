import { legacyState, mutateLegacy } from "./db/runtime";
import type { WatchedChannel, WatchFile } from "../lib/types";
import type { ChannelInfo, Upload } from "../src/youtube";

/**
 * Creators capy watches, in <CAPY_DATA_DIR>/watch.json. Every change is a pure function over the file
 * (tested directly); watch().mutate applies one and saves.
 */

const DAY = 86_400_000;
const SEEN_MAX = 500;
const HISTORY_MAX = 50;

export const DEFAULT_CHANNEL_SETTINGS: WatchedChannel["settings"] = {
  clips: 3,
  minVideoSec: 240,
  perDay: 2,
};

export const emptyWatch = (): WatchFile => ({
  channels: [],
  maxPerDay: 6,
  intervalMin: 60,
});

const clippable = (u: Upload, minSec: number) =>
  !u.live && u.duration !== undefined && u.duration >= minSec;

/** Start watching: what's on the channel now counts as seen; with clipLatest the newest clippable upload is queued. */
export function addChannel(
  file: WatchFile,
  info: ChannelInfo,
  uploads: Upload[],
  o: { now: Date; clipLatest?: boolean },
): WatchFile {
  if (file.channels.some((c) => c.id === info.id))
    throw Object.assign(new Error(`${info.name} is already watched`), {
      status: 409,
    });
  const settings = { ...DEFAULT_CHANNEL_SETTINGS };
  const latest = o.clipLatest
    ? uploads.find((u) => clippable(u, settings.minVideoSec))
    : undefined;
  const channel: WatchedChannel = {
    ...info,
    enabled: true,
    addedAt: o.now.getTime(),
    // only uploads published after this count as new; the uploads listed here are just the newest few
    discoveryAfter: o.now.getTime(),
    seen: uploads.filter((u) => u.id !== latest?.id).map((u) => u.id),
    pending: latest
      ? [
          {
            id: latest.id,
            title: latest.title,
            duration: latest.duration,
            foundAt: o.now.getTime(),
          },
        ]
      : [],
    history: [],
    settings,
  };
  return { ...file, channels: [...file.channels, channel] };
}

/** C1 imports predating the explicit field retain their original addedAt boundary without rewriting preferences. */
/** Uploads from this long before a channel was added still count as new. */
export const DISCOVERY_LOOKBACK_MS = 24 * 3600_000;
export const discoveryCutoff = (ch: WatchedChannel): number | undefined => {
  const start = ch.discoveryAfter ?? (ch.sourceAccountId ? ch.addedAt : undefined);
  return start === undefined ? undefined : start - DISCOVERY_LOOKBACK_MS;
};
/** The bounded-feed seam can only date uploads through the creator's reading account; without one it keeps
 *  the seen-list baseline taken when the channel was added. */
const datedCutoff = (ch: WatchedChannel) =>
  ch.sourceAccountId ? discoveryCutoff(ch) : undefined;

/** Sort a channel's latest uploads into new clippable ones, ones to skip for good, and ones to look at again later. */
export function diffUploads(
  ch: WatchedChannel,
  uploads: Upload[],
): { fresh: Upload[]; skipped: Upload[]; unknown: Upload[] } {
  const cutoff = datedCutoff(ch);
  const known = new Set([...ch.seen, ...ch.pending.map((p) => p.id)]);
  const fresh: Upload[] = [];
  const skipped: Upload[] = [];
  const unknown: Upload[] = [];
  for (const u of uploads) {
    if (known.has(u.id)) continue;
    if (cutoff !== undefined && !Number.isFinite(u.publishedAt))
      unknown.push(u);
    else if (cutoff !== undefined && u.publishedAt! <= cutoff) skipped.push(u);
    else if (u.live || u.duration === undefined)
      unknown.push(u); // live, upcoming, or a premiere without a length yet
    else if (u.duration < ch.settings.minVideoSec) skipped.push(u);
    else fresh.push(u);
  }
  return { fresh, skipped, unknown };
}

/** Record one check of a channel: new uploads join pending (oldest first), short ones are marked seen. */
export function applyCheck(
  file: WatchFile,
  channelId: string,
  uploads: Upload[],
  now: Date,
): WatchFile {
  return mapChannel(file, channelId, (ch) => {
    const { fresh, skipped, unknown } = diffUploads(ch, uploads);
    const waitingDates =
      datedCutoff(ch) === undefined
        ? []
        : unknown.filter((u) => !Number.isFinite(u.publishedAt));
    return {
      ...ch,
      lastCheckedAt: now.getTime(),
      lastError: waitingDates.length
        ? `Waiting for exact publication dates: ${waitingDates.map((u) => u.title).join(", ")}. These uploads are deferred, not queued.`
        : undefined,
      seen: [...ch.seen, ...skipped.map((u) => u.id)].slice(-SEEN_MAX),
      pending: [
        ...ch.pending,
        ...[...fresh]
          .reverse()
          .map((u) => ({
            id: u.id,
            title: u.title,
            duration: u.duration,
            foundAt: now.getTime(),
          })),
      ],
    };
  });
}

export function checkFailed(
  file: WatchFile,
  channelId: string,
  error: string,
  now: Date,
): WatchFile {
  return mapChannel(file, channelId, (ch) => ({
    ...ch,
    lastCheckedAt: now.getTime(),
    lastError: error,
  }));
}

const startedWithin = (ch: WatchedChannel, now: Date) =>
  ch.history.filter((h) => now.getTime() - h.at < DAY).length;

/**
 * The next video automation may start, if any: the oldest pending upload of an enabled channel that is under its own
 * daily cap, while the total for the day is under maxPerDay. The returned file has it moved to history.
 */
export function takeDue(
  file: WatchFile,
  now: Date,
  excludedChannels: string[] = [],
): {
  file: WatchFile;
  due?: {
    channelId: string;
    channelName: string;
    videoId: string;
    title: string;
  };
} {
  const total = file.channels.reduce((n, c) => n + startedWithin(c, now), 0);
  if (total >= file.maxPerDay) return { file };
  const candidates = file.channels
    .filter(
      (c) =>
        c.enabled &&
        !excludedChannels.includes(c.id) &&
        c.pending.length > 0 &&
        startedWithin(c, now) < c.settings.perDay,
    )
    .sort((a, b) => a.pending[0]!.foundAt - b.pending[0]!.foundAt);
  const ch = candidates[0];
  if (!ch) return { file };
  const next = ch.pending[0]!;
  const updated = mapChannel(file, ch.id, (c) => ({
    ...c,
    pending: c.pending.slice(1),
    seen: [...c.seen, next.id].slice(-SEEN_MAX),
    history: [
      {
        videoId: next.id,
        title: next.title,
        at: now.getTime(),
        jobId: next.id,
        status: "processing" as const,
      },
      ...c.history,
    ].slice(0, HISTORY_MAX),
  }));
  return {
    file: updated,
    due: {
      channelId: ch.id,
      channelName: ch.name,
      videoId: next.id,
      title: next.title,
    },
  };
}

/** Update the history entry of an automation job (jobs use the video id as their id). */
export function markHistory(
  file: WatchFile,
  jobId: string,
  status: "processing" | "rendered" | "error",
  error?: string,
  note?: string,
): WatchFile {
  return {
    ...file,
    channels: file.channels.map((c) =>
      c.history.some((h) => h.jobId === jobId)
        ? {
            ...c,
            history: c.history.map((h) =>
              h.jobId === jobId ? { ...h, status, error, note } : h,
            ),
          }
        : c,
    ),
  };
}

export function mapChannel(
  file: WatchFile,
  channelId: string,
  fn: (c: WatchedChannel) => WatchedChannel,
): WatchFile {
  return {
    ...file,
    channels: file.channels.map((c) => (c.id === channelId ? fn(c) : c)),
  };
}

// ---------- store ----------

declare global {
  // eslint-disable-next-line no-var
  var __capyWatch:
    { file: string; mtime: number; data: WatchFile } | null | undefined;
}

export function resetWatchCache() {
  globalThis.__capyWatch = null;
}

const validWatch = (value: unknown) =>
  !!value && Array.isArray((value as WatchFile).channels);
function load(): WatchFile {
  return legacyState("watch", emptyWatch, validWatch);
}

/** The watch list. `mutate` is synchronous, so two callers can never interleave a read-modify-write. */
export function watch() {
  return {
    get: () => load(),
    mutate(fn: (f: WatchFile) => WatchFile): WatchFile {
      return mutateLegacy("watch", emptyWatch, validWatch, fn);
    },
  };
}
