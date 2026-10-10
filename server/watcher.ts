import { fence, currentWork } from "./worker/context";
import { enqueueWork, workQueue } from "./worker/api";
import path from "node:path";
import type { JobSettings, JobState } from "../lib/types";
import type { Upload } from "../src/youtube";
import { takePosterLock } from "./poster-lock";
import { dataDir, effective } from "./settings";
import { readUploadDates } from "./subscriptions";
import {
  discoveryCutoff,
  applyCheck,
  checkFailed,
  markHistory,
  takeDue,
  watch,
} from "./watch";

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
  dateUploads?(accountId: string, uploads: Upload[]): Promise<Upload[]>;
  createJob(
    videoId: string,
    settings: Partial<JobSettings>,
    automation: NonNullable<JobState["automation"]>,
  ): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __capyWatcher:
    | { timer?: NodeJS.Timeout; running?: boolean; checking?: boolean }
    | undefined;
}
const state = () => (globalThis.__capyWatcher ??= {});

/** True while a check of the channels is running (the Automation page shows it). */
export const isChecking = () =>
  workQueue()
    .list()
    .some((x) => x.kind === "watcher" && x.status === "running");

function defaultDeps(): WatcherDeps {
  const yt = () => ({
    cookiesFromBrowser: effective().browser,
    proxy: process.env.YT_PROXY,
  });
  return {
    now: () => new Date(),
    lock: () => (currentWork() ? "held" : "busy"),
    list: async (url) =>
      (await import("../src/youtube")).listUploads(url, 12, yt()),
    createJob: async (videoId, settings, automation) => {
      const { jobs } = await import("./jobs");
      await jobs().create(
        `https://www.youtube.com/watch?v=${videoId}`,
        settings,
        { automation },
      );
    },
  };
}

/** One pass: list channels if a check is due (or forced), then start the next video if none is in flight. */
export async function watcherTick(
  d?: WatcherDeps,
  o: { force?: boolean } = {},
): Promise<void> {
  if (!d && !currentWork()) {
    await enqueueWork({
      kind: "watcher",
      workKey: "watcher:forced",
      inputRevision: Math.floor(Date.now() / 30_000),
      payload: { force: !!o.force },
    });
    return;
  }
  const deps = d ?? defaultDeps();
  if (deps.lock() === "busy") return;
  const now = deps.now();
  const file = watch().get();

  const due =
    o.force ||
    !file.lastCheckAt ||
    now.getTime() - file.lastCheckAt >= file.intervalMin * 60_000;
  if (due && file.channels.some((c) => c.enabled)) {
    state().checking = true;
    try {
      mutateWatch((f) => ({ ...f, lastCheckAt: now.getTime() }));
      for (const ch of file.channels.filter((c) => c.enabled)) {
        try {
          let uploads = await deps.list(ch.url);
          if (discoveryCutoff(ch) !== undefined) {
            if (!ch.sourceAccountId)
              throw new Error(
                "Reconnect the creator's original YouTube reading account to resolve publication dates",
              );
            uploads = await (deps.dateUploads ?? readUploadDates)(
              ch.sourceAccountId,
              uploads,
            );
          }
          mutateWatch((f) => applyCheck(f, ch.id, uploads, deps.now()));
        } catch (e) {
          mutateWatch((f) =>
            checkFailed(
              f,
              ch.id,
              (e instanceof Error ? e.message : String(e))
                .split("\n")
                .pop()!
                .slice(0, 200),
              deps.now(),
            ),
          );
        }
      }
    } finally {
      state().checking = false;
    }
  }

  // a video that never finished (capy closed mid-way, a hang) stops blocking the line after a while
  mutateWatch((f) => ({
    ...f,
    channels: f.channels.map((c) => ({
      ...c,
      history: c.history.map((h) =>
        h.status === "processing" && now.getTime() - h.at > STUCK_MS
          ? {
              ...h,
              status: "error" as const,
              error: "Took too long; open it to check",
            }
          : h,
      ),
    })),
  }));
  const inFlight = watch()
    .get()
    .channels.some((c) => c.history.some((h) => h.status === "processing"));
  if (inFlight) return;

  let next: ReturnType<typeof takeDue>["due"];
  mutateWatch((f) => {
    const r = takeDue(f, now);
    next = r.due;
    return r.file;
  });
  if (!next) return;
  const ch = watch()
    .get()
    .channels.find((c) => c.id === next!.channelId)!;
  try {
    await deps.createJob(
      next.videoId,
      {
        count: ch.settings.clips,
        ...(ch.settings.audience ? { audience: ch.settings.audience } : {}),
      },
      { channelId: ch.id, channelName: ch.name },
    );
  } catch (e) {
    mutateWatch((f) =>
      markHistory(
        f,
        next!.videoId,
        "error",
        e instanceof Error ? e.message.split("\n")[0]! : String(e),
      ),
    );
  }
}

/** Request handlers enqueue checks; the worker owns execution. */
export function kickWatcher() {
  void watcherTick().catch((e) => console.error("[watcher enqueue]", e));
}
export async function checkNow() {
  await watcherTick(undefined, { force: true });
}
export function startWatcher() {}
const mutateWatch: ReturnType<typeof watch>["mutate"] = (fn) =>
  fence(() => watch().mutate(fn));
