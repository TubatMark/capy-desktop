import type { WatchedChannel } from "../../lib/types";
import type { Upload } from "../../src/youtube";
import {
  parseDiscoveryVideos,
  type DiscoveryVideo,
} from "../../src/youtube-api";
import { loadAccounts, loadReadingAccount } from "../accounts";
import { runtimeStore } from "../db/runtime";
import { fence } from "../worker/context";
import { watch, mapChannel, discoveryCutoff } from "../watch";
import {
  abortable,
  classifyReadiness,
  readYoutube,
  type ReadinessDeps,
  type VideoReadiness,
} from "./readiness";

export interface DiscoveryResult {
  channelId: string;
  complete: boolean;
  discovered: number;
  reason?: string;
}
export interface DiscoveryState {
  lastSuccessAt?: number;
  watermark?: number;
  cursor?: string;
  /** Only completed scans establish a boundary. In-progress watermarks never imply success. */
  boundaryIds?: string[];
  scope?: { accountId?: string; cutoff?: number };
  scan?: { accountId: string; cutoff?: number; watermark?: number; headIds: string[]; complete?: boolean };

  failures: number;
  nextAttemptAt?: number;
  reason?: string;
  method?: "uploads-playlist" | "videos-tab";
}
export interface DiscoveryRecord extends VideoReadiness {
  channelId: string;
  videoId: string;
  accepted: boolean;
  checkedAt: number;
}
export interface DiscoveryDeps extends ReadinessDeps {
  force?: boolean;
  deadlineMs?: number;
  legacyList?: (
    channel: WatchedChannel,
    signal: AbortSignal,
  ) => Promise<Upload[]>;
}
export const discoveryState = (id: string): DiscoveryState =>
  runtimeStore().get<DiscoveryState>("discovery-state", id)?.value ?? {
    failures: 0,
  };
export const dueReadinessChannels = (now: number) =>
  new Set(
    runtimeStore()
      .list<DiscoveryRecord>("discovery-videos")
      .filter(
        (r) =>
          !r.value.accepted &&
          r.value.status === "wait-until" &&
          (r.value.retryAt ?? Infinity) <= now,
      )
      .map((r) => r.value.channelId),
  );
const ALREADY_THERE = "Already on the channel when you started watching";
/** Channels added by link before they recorded a start date queued their whole back catalog on the first
 *  scan. Give them their start date and take those old uploads out of line (clips already made stay). */
export function adoptStartDate(channelId: string): number {
  return fence(() =>
    runtimeStore().transaction(() => {
      const store = runtimeStore();
      let dropped: string[] = [];
      watch().mutate((file) =>
        mapChannel(file, channelId, (ch) => {
          if (ch.discoveryAfter !== undefined || ch.sourceAccountId) return ch;
          const publishedAt = (id: string) =>
            store.get<DiscoveryRecord>("discovery-videos", recordKey(channelId, id))
              ?.value.video?.publishedAt;
          // the upload picked by "also clip their newest video" was queued at addedAt itself
          const keep = (p: WatchedChannel["pending"][number]) =>
            p.foundAt === ch.addedAt || (publishedAt(p.id) ?? 0) > ch.addedAt;
          dropped = ch.pending.filter((p) => !keep(p)).map((p) => p.id);
          return {
            ...ch,
            discoveryAfter: ch.addedAt,
            pending: ch.pending.filter(keep),
            seen: [...new Set([...ch.seen, ...dropped])].slice(-500),
          };
        }),
      );
      for (const id of dropped) {
        const row = store.get<DiscoveryRecord>("discovery-videos", recordKey(channelId, id));
        if (row)
          store.save(
            "discovery-videos",
            recordKey(channelId, id),
            { ...row.value, status: "excluded", reason: ALREADY_THERE },
            row.revision,
          );
      }
      return dropped.length;
    }),
  );
}
const recordKey = (channelId: string, videoId: string) =>
  `${channelId}:${videoId}`;

/** Commit a completed page and its immutable source claims together; processing state is separate. */
export function recordDiscoveryPage(
  channelId: string,
  candidates: { id: string; readiness: VideoReadiness }[],
  now: Date,
  signal: AbortSignal,
  accountId?: string,
  /** Pages without publication dates: the first completed scan is the baseline of what was already on the
   *  channel; after it, only uploads that appear later are new. */
  dateless?: "baseline" | "after-baseline",
): number {
  signal.throwIfAborted();
  return fence(() =>
    runtimeStore().transaction(() => {
      signal.throwIfAborted();
      if (
        accountId &&
        (loadReadingAccount().account?.id !== accountId ||
          loadReadingAccount().needsReconnect)
      )
        throw Error(
          "The original YouTube reading account changed; reconnect it",
        );
      let added = 0;
      watch().mutate((file) =>
        mapChannel(file, channelId, (ch) => {
          if (!ch.enabled) return ch;
          if (ch.sourceAccountId && ch.sourceAccountId !== accountId)
            throw Error(
              "The creator's source principal changed during discovery",
            );
          const store = runtimeStore();
          const known = new Set([
            ...ch.seen,
            ...ch.pending.map((p) => p.id),
            ...ch.history.map((h) => h.videoId),
          ]);
          const pending = [...ch.pending];
          const seen = new Set(ch.seen);
          for (const candidate of candidates) {
            const key = recordKey(channelId, candidate.id);
            const old = store.get<DiscoveryRecord>("discovery-videos", key);
            if (old?.value.accepted || old?.value.status === "excluded")
              continue;
            let readiness = candidate.readiness;
            const cutoff = discoveryCutoff(ch);
            if (dateless === "baseline" && !known.has(candidate.id)) {
              readiness = {
                ...readiness,
                status: "excluded",
                reason: ALREADY_THERE,
              };
            } else if (
              !dateless &&
              cutoff !== undefined &&
              !Number.isFinite(readiness.video?.publishedAt)
            ) {
              // Private/deleted outcomes remain explicit; public videos without exact dates stay unseen.
              if (readiness.status !== "unavailable")
                readiness = {
                  ...readiness,
                  status: "wait-until",
                  reason:
                    "Waiting for exact publication date; upload is deferred, not queued",
                  retryAt: now.getTime() + 300_000,
                };
            } else if (
              cutoff !== undefined &&
              Number.isFinite(readiness.video?.publishedAt) &&
              readiness.video!.publishedAt! <= cutoff
            ) {
              readiness = {
                ...readiness,
                status: "excluded",
                reason: "Publication time is at or before the import cutoff",
              };
            }
            const accepted =
              known.has(candidate.id) ||
              (readiness.status === "ready" &&
                store.claim("discovery-source", `${key}:1`, key));
            if (
              accepted &&
              !known.has(candidate.id) &&
              readiness.status === "ready"
            ) {
              pending.push({
                id: candidate.id,
                title: readiness.video?.title ?? candidate.id,
                duration: readiness.video?.duration,
                foundAt: now.getTime(),
              });
              known.add(candidate.id);
              added++;
            }
            if (readiness.status === "excluded") seen.add(candidate.id);
            store.save(
              "discovery-videos",
              key,
              {
                ...readiness,
                channelId,
                videoId: candidate.id,
                accepted,
                checkedAt: now.getTime(),
              } satisfies DiscoveryRecord,
              old?.revision ?? 0,
            );
          }
          // Newest-first pages arrive separately; keep the complete pending queue oldest-first.
          pending.sort((a, b) => {
            const date = (id: string) =>
              store.get<DiscoveryRecord>(
                "discovery-videos",
                recordKey(channelId, id),
              )?.value.video?.publishedAt;
            return (date(a.id) ?? a.foundAt) - (date(b.id) ?? b.foundAt);
          });
          return { ...ch, seen: [...seen].slice(-500), pending };
        }),
      );
      return added;
    }),
  );
}
function summary(channelId: string, state: DiscoveryState, now: Date) {
  const records = runtimeStore()
    .list<DiscoveryRecord>("discovery-videos")
    .filter((r) => r.value.channelId === channelId)
    .map((r) => r.value);
  const deferred = records.filter(
    (r) => !r.accepted && ["wait-until", "unavailable"].includes(r.status),
  );
  const reasons = [...new Set(deferred.map((r) => r.reason))];
  watch().mutate((file) =>
    mapChannel(file, channelId, (ch) => ({
      ...ch,
      lastCheckedAt: now.getTime(),
      lastError:
        state.reason ??
        (reasons.length
          ? `${deferred.length} deferred: ${reasons.join("; ")}`.slice(0, 500)
          : undefined),
      discoveryStatus: {
        lastSuccessAt: state.lastSuccessAt,
        nextAttemptAt: state.nextAttemptAt,
        deferred: deferred.length,
        excluded: records.filter((r) => r.status === "excluded").length,
        method: state.method ?? "uploads-playlist",
      },
    })),
  );
}
/** Resume committed pages across deadlines; invalid provider cursors explicitly restart the scan. */
export async function reconcileCreator(
  channelId: string,
  signal: AbortSignal,
  deps: DiscoveryDeps = {},
): Promise<DiscoveryResult> {
  const ch = watch()
    .get()
    .channels.find((c) => c.id === channelId);
  if (!ch) throw Error("Creator is no longer watched");
  adoptStartDate(channelId);
  const now = deps.now?.() ?? new Date();
  const previous = discoveryState(channelId);
  if (!deps.force && (previous.nextAttemptAt ?? 0) > now.getTime())
    return {
      channelId,
      complete: false,
      discovered: 0,
      reason: previous.reason,
    };
  const store = runtimeStore();
  let stateRevision = store.get("discovery-state", channelId)?.revision ?? 0;
  const accountId = ch.sourceAccountId ?? loadReadingAccount().account?.id;
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(deps.deadlineMs ?? 30_000),
  ]);
  let discovered = 0;
  const scope = { accountId, cutoff: discoveryCutoff(ch) };
  const sameScope =
    previous.scope?.accountId === accountId && previous.scope?.cutoff === scope.cutoff;
  const resumable =
    previous.scan?.accountId === accountId && previous.scan?.cutoff === scope.cutoff;
  let cursor = resumable ? previous.cursor : undefined;
  let scan = resumable ? previous.scan : undefined;
  let watermark = scan?.watermark ?? previous.watermark;
  const saveProgress = () => {
    const current = { ...previous, cursor, scan, method, scope };
    const saved = store.save("discovery-state", channelId, current, stateRevision);
    stateRevision = saved.revision;
  };
  const method: DiscoveryState["method"] = accountId
    ? "uploads-playlist"
    : "videos-tab";
  try {
    if (loadAccounts().youtube.account?.id === channelId) {
      const reason =
        "Publishing destination channel is excluded to prevent recursive production";
      fence(() =>
        store.transaction(() => {
          const state: DiscoveryState = {
            ...previous,
            failures: 0,
            reason,
            method,
          };
          store.save("discovery-state", channelId, state, stateRevision);
          summary(channelId, state, now);
        }),
      );
      return { channelId, complete: true, discovered: 0, reason };
    }
    if (!accountId) {
      if (ch.sourceAccountId)
        throw Error(
          "Reconnect the creator's original YouTube reading account to resolve publication dates",
        );
      if (!deps.legacyList)
        throw Error(
          "Connect a YouTube reading account for complete uploads discovery",
        );
      const uploads = await abortable(deps.legacyList(ch, bounded), bounded);
      discovered += recordDiscoveryPage(
        channelId,
        uploads.map((video) => ({
          id: video.id,
          readiness: classifyReadiness(
            { ...video, broadcast: video.live ? "live" : "none" },
            { minVideoSec: ch.settings.minVideoSec, now: deps.now },
          ),
        })),
        now,
        bounded,
        undefined,
        previous.lastSuccessAt === undefined ? "baseline" : "after-baseline",
      );
    } else {
      const apiDeps = { ...deps, signal: bounded };
      const channel = await readYoutube(
        accountId,
        "channels",
        { part: "contentDetails", id: channelId },
        apiDeps,
      );
      const playlistId =
        channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!playlistId) throw Error("Channel uploads playlist is unavailable");
      // A completeness boundary must not hide premieres or records with unknown publication dates.
      const deferred = store.list<DiscoveryRecord>("discovery-videos")
        .map((r) => r.value)
        .filter((r) => r.channelId === channelId && !r.accepted && r.status !== "excluded" && (deps.force || (r.retryAt ?? 0) <= now.getTime()))
        .sort((a, b) => a.checkedAt - b.checkedAt).slice(0, 50);
      if (deferred.length && !scan?.complete) {
        const recheckSignal = AbortSignal.any([
          bounded, AbortSignal.timeout(Math.max(1, Math.floor((deps.deadlineMs ?? 30_000) / 4))),
        ]);
        try {
          const details = await readYoutube(accountId, "videos", {
            part: "snippet,contentDetails,status,liveStreamingDetails", id: deferred.map((r) => r.videoId).join(","),
          }, { ...apiDeps, signal: recheckSignal });
          const videos = new Map(parseDiscoveryVideos(details as Record<string, unknown>).map((v) => [v.id, v]));
          discovered += recordDiscoveryPage(channelId, deferred.map((r) => ({ id: r.videoId,
            readiness: classifyReadiness(videos.get(r.videoId), { channelId, minVideoSec: ch.settings.minVideoSec, now: deps.now }),
          })), now, bounded, accountId);
        } catch (error) {
          // Slow readiness checks retain their durable records and must not starve pagination.
          if (!recheckSignal.aborted || bounded.aborted) throw error;
        }
      }
      const cursors = new Set<string>(cursor ? [cursor] : []);
      if (!scan?.complete) do {
        const page = await readYoutube(
          accountId,
          "playlistItems",
          {
            part: "snippet,contentDetails",
            playlistId,
            maxResults: "50",
            ...(cursor ? { pageToken: cursor } : {}),
          },
          apiDeps,
        );
        const ids = [
          ...new Set(
            (page.items ?? [])
              .map(
                (i) =>
                  i.contentDetails?.videoId ?? i.snippet?.resourceId?.videoId,
              )
              .filter((id): id is string => !!id),
          ),
        ];
        if (ids.length > 50)
          throw Error("YouTube returned too many uploads in one page");
        const details = ids.length
          ? await readYoutube(
              accountId,
              "videos",
              {
                part: "snippet,contentDetails,status,liveStreamingDetails",
                id: ids.join(","),
              },
              apiDeps,
            )
          : { items: [] };
        const videos = new Map(
          parseDiscoveryVideos(details as Record<string, unknown>).map((v) => [
            v.id,
            v,
          ]),
        );
        for (const video of videos.values())
          if (Number.isFinite(video.publishedAt))
            watermark = Math.max(watermark ?? 0, video.publishedAt!);
        // A prior fully visited head is a safe stopping point in the newest-first uploads playlist.
        // Deferred entries below it have their own explicit readiness rechecks above.
        const reachedBoundary = sameScope && !!previous.lastSuccessAt && ids.some((id) => previous.boundaryIds?.includes(id));
        if (!scan) scan = { accountId, cutoff: discoveryCutoff(ch), headIds: ids, watermark };
        discovered += store.transaction(() => {
          const added = recordDiscoveryPage(
            channelId,
            ids.map((id) => ({
              id,
              readiness: classifyReadiness(videos.get(id), {
                channelId,
                minVideoSec: ch.settings.minVideoSec,
                now: deps.now,
              }),
            })),
            now,
            bounded,
            accountId,
          );
          cursor = reachedBoundary ? undefined : page.nextPageToken;
          scan = { ...scan!, watermark, complete: !cursor };
          saveProgress();
          return added;
        });
        if (cursor && cursors.has(cursor))
          throw Object.assign(Error("YouTube repeated an uploads page; reconciliation is incomplete"), { providerReason: "invalidPageToken" });
        if (cursor) cursors.add(cursor);
        if (cursors.size >= 10_000)
          throw Error(
            "Uploads reconciliation page limit reached; success watermark retained",
          );
      } while (cursor);
    }
    bounded.throwIfAborted();
    fence(() =>
      store.transaction(() => {
        const state: DiscoveryState = {
          failures: 0,
          lastSuccessAt: now.getTime(),
          watermark,
          boundaryIds: scan?.headIds ?? previous.boundaryIds,
          scope,
          method,
        };
        store.save("discovery-state", channelId, state, stateRevision);
        summary(channelId, state, now);
      }),
    );
    return { channelId, complete: true, discovered };
  } catch (error) {
    // A cancelled/stale worker has no authority to publish health or success state.
    if (
      signal.aborted &&
      (signal.reason as Error | undefined)?.name !== "TimeoutError"
    )
      signal.throwIfAborted();
    const invalidCursor = (error as { providerReason?: string })?.providerReason === "invalidPageToken";
    if (invalidCursor) { cursor = undefined; scan = undefined; }
    const reason = invalidCursor ? "Uploads cursor expired; restarting safely with video-ID deduplication" : error instanceof Error ? error.message : String(error);
    fence(() =>
      store.transaction(() => {
        const failures = previous.failures + 1;
        const state: DiscoveryState = {
          ...previous,
          failures,
          cursor,
          scan,
          scope,
          reason,
          method,
          nextAttemptAt:
            now.getTime() +
            Math.min(3_600_000, 30_000 * 2 ** Math.min(failures - 1, 7)),
        };
        store.save("discovery-state", channelId, state, stateRevision);
        summary(channelId, state, now);
      }),
    );
    return { channelId, complete: false, discovered, reason };
  }
}
