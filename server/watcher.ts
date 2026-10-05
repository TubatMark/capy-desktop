import path from "node:path";
import type { JobSettings, JobState } from "../lib/types";
import type { Upload } from "../src/youtube";
import { takePosterLock } from "./poster-lock";
import { dataDir, effective } from "./settings";
import { applyCheck, checkFailed, markHistory, takeDue, watch } from "./watch";

/**
 * Creator automation: every so often list each watched channel's uploads, queue the new ones, and send them through
 * the pipeline one at a time. Clips end up in Queue → Waiting for your OK; nothing here posts anything.
 */

const STUCK_MS = 6 * 3_600_000;

export interface WatcherDeps {
  now(): Date;
  /** One watcher per data folder (the packaged app and `pnpm dev` share it). */
  lock(): "acquired" | "held" | "busy";
  list(channelUrl: string): Promise<Upload[]>;
  createJob(videoId: string, settings: Partial<JobSettings>, automation: NonNullable<JobState["automation"]>): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __capyWatcher: { timer?: NodeJS.Timeout; running?: boolean; checking?: boolean } | undefined;
}
const state = () => (globalThis.__capyWatcher ??= {});

/** True while a check of the channels is running (the Automation page shows it). */
export const isChecking = () => !!state().checking;

function defaultDeps(): WatcherDeps {
  const yt = () => ({ cookiesFromBrowser: effective().browser, proxy: process.env.YT_PROXY });
  return {
    now: () => new Date(),
    lock: () => takePosterLock(path.join(dataDir(), "watcher.lock"), Date.now()),
    list: async (url) => (await import("../src/youtube")).listUploads(url, 12, yt()),
    createJob: async (videoId, settings, automation) => {
      const { jobs } = await import("./jobs");
      await jobs().create(`https://www.youtube.com/watch?v=${videoId}`, settings, { automation });
    },
  };
}

/** One pass: list channels if a check is due (or forced), then start the next video if none is in flight. */
export async function watcherTick(d: WatcherDeps = defaultDeps(), o: { force?: boolean } = {}): Promise<void> {
  if (d.lock() === "busy") return;
  const now = d.now();
  const file = watch().get();

  const due = o.force || !file.lastCheckAt || now.getTime() - file.lastCheckAt >= file.intervalMin * 60_000;
  if (due && file.channels.some((c) => c.enabled)) {
    state().checking = true;
    try {
      watch().mutate((f) => ({ ...f, lastCheckAt: now.getTime() }));
      for (const ch of file.channels.filter((c) => c.enabled)) {
        try {
          const uploads = await d.list(ch.url);
          watch().mutate((f) => applyCheck(f, ch.id, uploads, d.now()));
        } catch (e) {
          watch().mutate((f) => checkFailed(f, ch.id, (e instanceof Error ? e.message : String(e)).split("\n").pop()!.slice(0, 200), d.now()));
        }
      }
    } finally {
      state().checking = false;
    }
  }

  // a video that never finished (capy closed mid-way, a hang) stops blocking the line after a while
  watch().mutate((f) => ({
    ...f,
    channels: f.channels.map((c) => ({
      ...c,
      history: c.history.map((h) => (h.status === "processing" && now.getTime() - h.at > STUCK_MS ? { ...h, status: "error" as const, error: "Took too long; open it to check" } : h)),
    })),
  }));
  const inFlight = watch()
    .get()
    .channels.some((c) => c.history.some((h) => h.status === "processing"));
  if (inFlight) return;

  let next: ReturnType<typeof takeDue>["due"];
  watch().mutate((f) => {
    const r = takeDue(f, now);
    next = r.due;
    return r.file;
  });
  if (!next) return;
  const ch = watch()
    .get()
    .channels.find((c) => c.id === next!.channelId)!;
  try {
    await d.createJob(next.videoId, { count: ch.settings.clips, ...(ch.settings.audience ? { audience: ch.settings.audience } : {}) }, { channelId: ch.id, channelName: ch.name });
  } catch (e) {
    watch().mutate((f) => markHistory(f, next!.videoId, "error", e instanceof Error ? e.message.split("\n")[0]! : String(e)));
  }
}

/** Run a check right away (the "Check now" button). */
export async function checkNow(): Promise<void> {
  await watcherTick(defaultDeps(), { force: true });
}

/** Start the once-a-minute loop (first pass after 2 minutes). Never during `next build`. */
export function startWatcher() {
  const s = state();
  if (s.timer || process.env.NEXT_PHASE === "phase-production-build") return;
  const run = async () => {
    if (s.running) return;
    s.running = true;
    try {
      await watcherTick();
    } catch (e) {
      console.error("[watcher]", e);
    } finally {
      s.running = false;
    }
  };
  setTimeout(() => void run(), 120_000).unref();
  s.timer = setInterval(() => void run(), 60_000);
  s.timer.unref();
}

