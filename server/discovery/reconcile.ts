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
const recordKey = (channelId: string, videoId: string) =>
  `${channelId}:${videoId}`;

/** Commit a completed page and its immutable source claims together; processing state is separate. */
export function recordDiscoveryPage(
  channelId: string,
  candidates: { id: string; readiness: VideoReadiness }[],
  now: Date,
  signal: AbortSignal,
  accountId?: string,
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
            if (
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
/** Restart from the first page after failure: provider page tokens are not stable historical cursors. */
export async function reconcileCreator(
  channelId: string,
  signal: AbortSignal,
  deps: DiscoveryDeps = {},
): Promise<DiscoveryResult> {
  const ch = watch()
    .get()
    .channels.find((c) => c.id === channelId);
  if (!ch) throw Error("Creator is no longer watched");
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
  const stateRevision = store.get("discovery-state", channelId)?.revision ?? 0;
  const accountId = ch.sourceAccountId ?? loadReadingAccount().account?.id;
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(deps.deadlineMs ?? 30_000),
  ]);
  let discovered = 0;
  let cursor: string | undefined;
  let watermark = previous.watermark;
  let method: DiscoveryState["method"] = accountId
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
      if (discoveryCutoff(ch) !== undefined)
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
      const cursors = new Set<string>();
      do {
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
        discovered += recordDiscoveryPage(
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
        cursor = page.nextPageToken;
        if (cursor && cursors.has(cursor))
          throw Error(
            "YouTube repeated an uploads page; reconciliation is incomplete",
          );
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
    const reason = error instanceof Error ? error.message : String(error);
    fence(() =>
      store.transaction(() => {
        const failures = previous.failures + 1;
        const state: DiscoveryState = {
          ...previous,
          failures,
          cursor,
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
