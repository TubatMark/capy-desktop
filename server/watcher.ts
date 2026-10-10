import { fence, currentWork } from "./worker/context";
import { enqueueWork, workQueue } from "./worker/api";
import path from "node:path";
import type { JobSettings, JobState } from "../lib/types";
import type { Upload } from "../src/youtube";
import { takePosterLock } from "./poster-lock";
import { dataDir, effective } from "./settings";
import { readUploadDates } from "./subscriptions";
import { loadAccounts } from "./accounts";
import {
  reconcileCreator,
  dueReadinessChannels,
  type DiscoveryResult,
} from "./discovery/reconcile";
import { abortable } from "./discovery/readiness";
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
  reconcile?(
    channelId: string,
    signal: AbortSignal,
    force: boolean,
  ): Promise<DiscoveryResult>;
  deadlineMs?: number;
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
    list: async () => {
      throw Error("Worker discovery uses the complete uploads reconciler");
    },
    reconcile: (channelId, signal, force) =>
      reconcileCreator(channelId, signal, {
        force,
        legacyList: async (channel, signal) => {
          const { run, withCancel } = await import("../src/exec");
          const { parseUploads } = await import("../src/youtube");
          const options = yt();
          const args = ["--no-warnings", "--flat-playlist", "-J"];
          if (options.cookiesFromBrowser)
            args.push("--cookies-from-browser", options.cookiesFromBrowser);
          if (options.proxy) args.push("--proxy", options.proxy);
          // No playlist-end: catch up the complete Videos tab, subject to explicit output/deadline limits.
          args.push(`https://www.youtube.com/channel/${channel.id}/videos`);
          const result = await withCancel(signal, () =>
            run("yt-dlp", args, { timeoutMs: 30_000 }),
          );
          return parseUploads(JSON.parse(result.stdout));
        },
      }),
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
  const readinessDue = dueReadinessChannels(now.getTime());
  if ((due || readinessDue.size > 0) && file.channels.some((c) => c.enabled)) {
    state().checking = true;
    try {
      if (due) mutateWatch((f) => ({ ...f, lastCheckAt: now.getTime() }));
      const channels = file.channels.filter(
        (c) => c.enabled && (due || readinessDue.has(c.id)),
      );
      let position = 0;
      const checkChannel = async () => {
        while (position < channels.length) {
          const ch = channels[position++]!;
          const signal = AbortSignal.any([
            currentWork()?.signal ?? new AbortController().signal,
            AbortSignal.timeout(deps.deadlineMs ?? 30_000),
          ]);
          try {
            if (deps.reconcile) {
              await abortable(deps.reconcile(ch.id, signal, !!o.force), signal);
              continue;
            }
            // Compatibility seam for bounded-feed callers; normal worker discovery uses the paginated reconciler.
            let uploads = await abortable(deps.list(ch.url), signal);
            if (discoveryCutoff(ch) !== undefined) {
              if (!ch.sourceAccountId)
                throw new Error(
                  "Reconnect the creator's original YouTube reading account to resolve publication dates",
                );
              uploads = await abortable(
                (deps.dateUploads ?? readUploadDates)(
                  ch.sourceAccountId,
                  uploads,
                ),
                signal,
              );
            }
            signal.throwIfAborted();
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
      };
      await Promise.all(
        Array.from({ length: Math.min(3, channels.length) }, checkChannel),
      );
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
    const destination = loadAccounts().youtube.account?.id;
    const r = takeDue(f, now, destination ? [destination] : []);
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
