import {
  admissionReasons,
  existingAutomationIntakeReason,
  recipeIdForPolicy,
  recordCreatorJobAdmission,
  AutomationIntakeDeferredError,
  type CreatorJobAdmission,
  unpublishedAutomatedClips,
  rankCreatorWork,
  saveCreatorPolicy,
  saveWorkDecision,
  recipeSettings,
  unsavedCreatorPolicy,
} from "./automation-policy";
import { loadSettings } from "./settings";
import { loadReadingAccount, publicAccounts } from "./accounts";
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
  pullChannelEvents,
  pendingChannelEvents,
  acknowledgeChannelEvents,
} from "./discovery/events";
import { runtimeStore } from "./db/runtime";
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
  pullEvents?(signal: AbortSignal): Promise<number>;
  createJob(
    videoId: string,
    settings: Partial<JobSettings>,
    automation: NonNullable<JobState["automation"]>,
  ): Promise<void>;
  /** The real worker commits immutable admission and new job before enqueue. Legacy injected seams stay three-argument. */
  createAdmittedJob?(
    videoId: string,
    settings: Partial<JobSettings>,
    automation: NonNullable<JobState["automation"]>,
    admission: CreatorJobAdmission,
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
    pullEvents: process.env.CAPY_YOUTUBE_EVENTS_URL
      ? (signal) => pullChannelEvents(signal)
      : undefined,
    reconcile: (channelId, signal, force) =>
      reconcileCreator(channelId, signal, {
        force,
        legacyList: async (channel, signal) => {
          const { run, withCancel } = await import("../src/exec");
          const { parseUploads } = await import("../src/youtube");
          const options = yt();
          // Only uploads the public feed dates (its newest 15) can be new, so the newest 30 of each tab is enough.
          // Stream replays live on the Live tab, not the Videos tab. Shorts are skipped by length anyway.
          const tab = async (name: "videos" | "streams") => {
            const args = ["--no-warnings", "--flat-playlist", "-J", "--playlist-end", "30"];
            if (options.cookiesFromBrowser)
              args.push("--cookies-from-browser", options.cookiesFromBrowser);
            if (options.proxy) args.push("--proxy", options.proxy);
            args.push(`https://www.youtube.com/channel/${channel.id}/${name}`);
            const result = await withCancel(signal, () =>
              run("yt-dlp", args, { timeoutMs: 25_000 }),
            );
            return parseUploads(JSON.parse(result.stdout));
          };
          const [videos, streams] = await Promise.all([
            tab("videos"),
            // a channel without a Live tab is fine
            tab("streams").catch(() => []),
          ]);
          return [...videos, ...streams];
        },
      }),
    createJob: async () => {
      throw Error(
        "Production automatic intake requires an immutable creator admission",
      );
    },
    createAdmittedJob: async (videoId, settings, automation, admission) => {
      const { jobs } = await import("./jobs");
      await jobs().create(
        `https://www.youtube.com/watch?v=${videoId}`,
        settings,
        {
          automation: { ...automation, recipeId: admission.recipeId },
          automationAdmission: admission,
        },
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
  if (admissionReasons({ kind: "watcher" }).length) return;
  if (deps.pullEvents) {
    const workerSignal = currentWork()?.signal ?? new AbortController().signal;
    try {
      const signal = AbortSignal.any([
        workerSignal,
        AbortSignal.timeout(10_000),
      ]);
      await abortable(deps.pullEvents(signal), signal);
      fence(() =>
        runtimeStore().mutate(
          "discovery-receiver-health",
          "service",
          () => ({}),
          () => ({
            lastAttemptAt: now.getTime(),
            lastSuccessAt: now.getTime(),
          }),
        ),
      );
    } catch (error) {
      workerSignal.throwIfAborted();
      fence(() =>
        runtimeStore().mutate<Record<string, unknown>>(
          "discovery-receiver-health",
          "service",
          () => ({}),
          (health) => ({
            ...health,
            lastAttemptAt: now.getTime(),
            error:
              error instanceof Error
                ? error.message.slice(0, 300)
                : String(error).slice(0, 300),
          }),
        ),
      );
    }
  }
  const eventHints = pendingChannelEvents();
  const file = watch().get();

  const due =
    o.force ||
    !file.lastCheckAt ||
    now.getTime() - file.lastCheckAt >= file.intervalMin * 60_000;
  const readinessDue = dueReadinessChannels(now.getTime());
  if (
    (due || readinessDue.size > 0 || eventHints.size > 0) &&
    file.channels.some((c) => c.enabled)
  ) {
    state().checking = true;
    try {
      if (due) mutateWatch((f) => ({ ...f, lastCheckAt: now.getTime() }));
      const channels = file.channels.filter(
        (c) =>
          c.enabled && (due || readinessDue.has(c.id) || eventHints.has(c.id)),
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
              const result = await abortable(
                deps.reconcile(ch.id, signal, !!o.force),
                signal,
              );
              const revision = eventHints.get(ch.id);
              if (result.complete && revision !== undefined)
                acknowledgeChannelEvents(ch.id, revision);
              continue;
            }
            // Compatibility seam for bounded-feed callers; normal worker discovery uses the paginated reconciler.
            let uploads = await abortable(deps.list(ch.url), signal);
            if (ch.sourceAccountId && discoveryCutoff(ch) !== undefined) {
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

  if (admissionReasons({ kind: "media" }).length) return;
  const settings = loadSettings();
  const current = watch().get();
  const accounts = publicAccounts().filter(
    (a) => a.connected && !a.needsReconnect && a.account?.id,
  );
  const reading = loadReadingAccount();
  const unpublished = unpublishedAutomatedClips();
  const admissions = runtimeStore()
    .list<{ at: number; clips: number }>("automation-admissions")
    .map((r) => r.value)
    .filter((r) => now.getTime() - r.at < 86400000);
  const dayClips = Math.max(
    admissions.reduce((n, r) => n + r.clips, 0),
    current.channels.reduce(
      (n, c) =>
        n +
        c.history.filter((h) => now.getTime() - h.at < 86400000).length *
          (settings.creatorPolicies?.[c.id]?.clips ?? c.settings.clips),
      0,
    ),
  );
  const existingJobs = new Map(
    runtimeStore()
      .list<JobState>("legacy-jobs")
      .map((row) => [row.value.videoId, row.value]),
  );
  const decisions = rankCreatorWork(
    current.channels
      .filter((c) => c.enabled)
      .flatMap((c) =>
        c.pending.map((v) => {
          const configured = settings.creatorPolicies?.[c.id];
          const policy =
            configured ??
            unsavedCreatorPolicy(
              c,
              accounts.map((a) => a.account!.id),
            );
          const destination =
            configured && policy.destinationAccountIds.length
              ? accounts.find((a) =>
                  policy.destinationAccountIds.includes(a.account!.id),
                )?.account?.id
              : "local-drafts";
          return {
            existingJobConflict: existingAutomationIntakeReason(
              existingJobs.get(v.id),
              { channelId: c.id, recipeId: recipeIdForPolicy(policy) },
            ),
            candidate: {
              id: v.id,
              channelId: c.id,
              title: v.title,
              foundAt: v.foundAt,
              durationSec: v.duration,
              sourceMethod: c.discoveryStatus?.method,
              ...(() => {
                const video = runtimeStore().get<{
                  video?: { endedAt?: number; publishedAt?: number };
                }>("discovery-videos", `${c.id}:${v.id}`)?.value.video;
                return {
                  isArchive: !!video?.endedAt,
                  publishedAt: video?.publishedAt,
                };
              })(),
            },
            policy,
            now: now.getTime(),
            sourceAllowed:
              !c.sourceAccountId ||
              (!!reading.tokens?.accessToken &&
                !reading.needsReconnect &&
                reading.account?.id === c.sourceAccountId),
            destinationAccountId: destination,
            capacity: {
              unpublished,
              reservedClips: 0,
              destinationDailySlots: policy.destinationDailySlots,
              targetDays: policy.targetQueueDays,
              maxBacklogDays: policy.maxBacklogDays,
              remainingRenderClips:
                current.channels.reduce(
                  (n, ch) =>
                    n +
                    ch.history.filter((h) => now.getTime() - h.at < 86400000)
                      .length,
                  0,
                ) >= current.maxPerDay ||
                c.history.filter((h) => now.getTime() - h.at < 86400000)
                  .length >= c.settings.perDay
                  ? 0
                  : Math.max(0, policy.dailyClipCap - dayClips),
            },
          };
        }),
      ),
  );
  for (const decision of decisions) {
    const channel = current.channels.find((c) =>
      c.pending.some((v) => v.id === decision.candidateId),
    );
    if (channel) saveWorkDecision(channel.id, decision);
  }
  const skipped = new Set(
    decisions.filter((d) => d.kind === "skip").map((d) => d.candidateId),
  );
  if (skipped.size)
    mutateWatch((f) => ({
      ...f,
      channels: f.channels.map((c) => ({
        ...c,
        pending: c.pending.filter((v) => !skipped.has(v.id)),
        seen: [
          ...c.seen,
          ...c.pending.filter((v) => skipped.has(v.id)).map((v) => v.id),
        ].slice(-1000),
      })),
    }));
  const admitted = decisions.find((d) => d.kind === "proceed");
  if (!admitted) return;
  let next: ReturnType<typeof takeDue>["due"];
  mutateWatch((f) => {
    const destination = loadAccounts().youtube.account?.id;
    // Rank first; only the selected affordable candidate is eligible for this one-at-a-time admission.
    const eligible = {
      ...f,
      channels: f.channels.map((c) => ({
        ...c,
        pending: c.pending.filter((v) => v.id === admitted.candidateId),
      })),
    };
    const r = takeDue(eligible, now, destination ? [destination] : []);
    r.file = {
      ...r.file,
      channels: r.file.channels.map((c) => ({
        ...c,
        pending: f.channels
          .find((original) => original.id === c.id)!
          .pending.filter((v) => v.id !== r.due?.videoId),
      })),
    };
    next = r.due;
    return r.file;
  });
  if (!next) return;
  const ch = watch()
    .get()
    .channels.find((c) => c.id === next!.channelId)!;
  try {
    const configured = settings.creatorPolicies?.[ch.id];
    const recipe = admitted.recipe!;
    if (configured && !configured.recipeId)
      saveCreatorPolicy(ch.id, configured);
    const admission: CreatorJobAdmission = {
      channelId: ch.id,
      recipeId: recipe.id,
      clips: recipe.clips,
      at: now.getTime(),
      destination: admitted.destination,
      sourceAccountId: ch.sourceAccountId,
      sourceMethod:
        ch.discoveryStatus?.method ??
        (ch.sourceAccountId ? "uploads-playlist" : "videos-tab"),
    };
    fence(() => {
      if (!runtimeStore().get("creator-recipes", recipe.id))
        runtimeStore().put("creator-recipes", recipe.id, recipe);
    });
    const jobSettings = {
      ...recipeSettings(recipe),
      count: recipe.clips,
      ...(ch.settings.audience ? { audience: ch.settings.audience } : {}),
    };
    const automation = {
      channelId: ch.id,
      channelName: ch.name,
      ...(configured ? { recipeId: recipe.id } : {}),
    };
    if (deps.createAdmittedJob)
      await deps.createAdmittedJob(
        next.videoId,
        jobSettings,
        automation,
        admission,
      );
    else await deps.createJob(next.videoId, jobSettings, automation);
    // Injected create seams have no queue owner; real Jobs.create records this atomically before enqueue.
    fence(() =>
      runtimeStore().transaction(() => {
        const created = runtimeStore()
          .list<JobState>("legacy-jobs")
          .find((row) => row.value.videoId === next!.videoId)?.value;
        if (created && !runtimeStore().get("automation-jobs", created.id)) {
          if (
            created.automation?.channelId !== ch.id ||
            created.automation.recipeId !== recipe.id
          )
            throw new AutomationIntakeDeferredError(
              "Existing manual job owns this source; automatic intake is deferred to preserve it",
            );
        }
        recordCreatorJobAdmission(next!.videoId, admission);
      }),
    );
  } catch (e) {
    if (e instanceof AutomationIntakeDeferredError) {
      saveWorkDecision(ch.id, {
        candidateId: next!.videoId,
        kind: "defer",
        reason: e.message,
        budget: { clips: 0 },
      });
      const source = current.channels
        .find((c) => c.id === ch.id)
        ?.pending.find((v) => v.id === next!.videoId);
      mutateWatch((f) => ({
        ...f,
        channels: f.channels.map((c) =>
          c.id !== ch.id
            ? c
            : {
                ...c,
                history: c.history.filter(
                  (h) =>
                    !(
                      h.jobId === next!.videoId &&
                      h.status === "processing" &&
                      h.at === now.getTime()
                    ),
                ),
                pending:
                  source && !c.pending.some((v) => v.id === source.id)
                    ? [...c.pending, source]
                    : c.pending,
              },
        ),
      }));
      return;
    }
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
