import { z } from "zod";
import type { Platform } from "../lib/types";
import type { DeliveryAttributionProjection } from "../lib/delivery";
import {
  MetricsSchema,
  RemoteChangeSchema,
  METRIC_KEYS,
  type MetricKey,
  type MetricObservation,
  type MetricUnavailableReason,
  type PublicationMetrics,
  type PublicationAttributionSnapshot,
  type PerformancePublication,
  type MetricsRefresh,
  type RecipePerformance,
} from "../lib/performance";
import { runtimeStore } from "./db/runtime";
import type { Store } from "./db";
import { listDeliveryAttributions } from "./delivery-store";
import { getPublicationAttribution } from "./publication-attribution";
import { getAccessToken, loadAccounts } from "./accounts";
import { hashManifest } from "./publication-policy";
import { call, readJson } from "./platforms/types";
const TTL = 30 * 86400000;
export const METRICS_STALE_MS = 6 * 3600000;
const LIMIT = 50;
export interface MetricsDestination {
  id: string;
  platform: Platform;
  clientId?: string;
  epoch: string;
  connected: boolean;
  scope?: string;
}
export interface PerformanceDeps {
  store: Store;
  now(): number;
  destination(id: string): MetricsDestination | undefined;
  token(id: string): Promise<string>;
  fetch: typeof fetch;
  deliveries(): DeliveryAttributionProjection[];
  attribution(hash: string): PublicationAttributionSnapshot | undefined;
}
const CacheSchema = z.strictObject({
  version: z.literal(1),
  accountId: z.string(),
  platform: z.enum(["youtube", "instagram", "tiktok"]),
  remoteId: z.string(),
  clientId: z.string().optional(),
  checkedAt: z.number(),
  expiresAt: z.number(),
  metrics: MetricsSchema,
});
export const pacificDay = (at: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
const keyOf = (platform: Platform, accountId: string, id: string) =>
  JSON.stringify([platform, accountId, id]);
const unavailable = (
  key: MetricKey,
  reason: MetricUnavailableReason,
  checkedAt: number,
  old?: MetricObservation,
): MetricObservation => {
  const last = old?.availability === "available" ? old : old?.lastAvailable;
  return {
    availability: "unavailable",
    metric: key,
    reason,
    checkedAt,
    lastAvailable: last && checkedAt - last.measuredAt < TTL ? last : undefined,
  };
};
const empty = (
  reason: MetricUnavailableReason,
  now: number,
): PublicationMetrics =>
  Object.fromEntries(
    METRIC_KEYS.map((k) => [k, unavailable(k, reason, now)]),
  ) as PublicationMetrics;
const inflight = new Map<string, Promise<MetricsRefresh>>();
const values: Record<
  MetricKey,
  { api: string; unit: "count" | "minutes" | "seconds" | "percent" }
> = {
  views: { api: "viewCount", unit: "count" },
  likes: { api: "likeCount", unit: "count" },
  comments: { api: "commentCount", unit: "count" },
  analyticsViews: { api: "views", unit: "count" },
  engagedViews: { api: "engagedViews", unit: "count" },
  estimatedMinutesWatched: { api: "estimatedMinutesWatched", unit: "minutes" },
  averageViewDuration: { api: "averageViewDuration", unit: "seconds" },
  averageViewPercentage: { api: "averageViewPercentage", unit: "percent" },
};
const rawNumber = (v: unknown, count: boolean) => {
  if (
    v === null ||
    v === undefined ||
    (typeof v === "string" &&
      !/^[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i.test(v)) ||
    typeof v === "boolean" ||
    !["number", "string"].includes(typeof v)
  )
    return;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && (!count || Number.isSafeInteger(n))
    ? n
    : undefined;
};
function defaultDeps(): PerformanceDeps {
  return {
    store: runtimeStore(),
    now: Date.now,
    fetch,
    deliveries: listDeliveryAttributions,
    attribution: getPublicationAttribution,
    destination: (id) => {
      for (const platform of ["youtube", "instagram", "tiktok"] as const) {
        const a = loadAccounts()[platform],
          stable = platform === "instagram" ? a.igUserId : a.account?.id;
        if (stable === id)
          return {
            id,
            platform,
            clientId: a.clientId,
            epoch: hashManifest({
              clientId: a.clientId,
              connectedAt: a.connectedAt,
              tokens: a.tokens,
              needsReconnect: a.needsReconnect,
            }),
            connected: !!a.tokens?.accessToken && !a.needsReconnect,
            scope: a.tokens?.scope,
          };
      }
      return undefined;
    },
    token: (id) => getAccessToken("youtube", fetch, id),
  };
}
function localSuggestions(): RecipePerformance["suggestions"] {
  return [
    {
      axis: "creator",
      source: "capy-local",
      adoption: "manual",
      text: "Choose a creator whose future recipe you want to review.",
      href: "/automation",
    },
    {
      axis: "topic",
      source: "capy-local",
      adoption: "manual",
      text: "Review your own included and excluded source topics.",
      href: "/automation",
    },
    {
      axis: "length",
      source: "capy-local",
      adoption: "manual",
      text: "Open the local clip to review a shorter or longer cut. Source duration filters control source videos.",
      href: "/automation",
    },
    {
      axis: "template",
      source: "capy-local",
      adoption: "manual",
      text: "Try a supported local edit template in a recipe draft, then save only if you choose.",
      href: "/automation",
    },
  ];
}
export function createPerformanceService(d: PerformanceDeps) {
  const generation = (id: string) =>
    d.store.get<{ generation: number }>("performance-refresh", id)?.value
      .generation ?? 0;
  function expire() {
    const now = d.now();
    d.store.transaction(() => {
      for (const row of d.store.list<{ expiresAt?: number }>(
        "publication-metrics",
      ))
        if (!row.value.expiresAt || row.value.expiresAt <= now)
          d.store.db
            .prepare("DELETE FROM documents WHERE kind=? AND id=?")
            .run("publication-metrics", row.id);
    });
  }
  function purgePublicationMetrics(accountId: string) {
    d.store.transaction(() => {
      d.store.mutate(
        "performance-refresh",
        accountId,
        () => ({ generation: 0 }),
        (x) => ({ generation: x.generation + 1 }),
      );
      for (const row of d.store.list<{ accountId?: string }>(
        "publication-metrics",
      ))
        if (row.value.accountId === accountId)
          d.store.db
            .prepare("DELETE FROM documents WHERE kind=? AND id=?")
            .run("publication-metrics", row.id);
    });
  }
  function publicationMetrics(destinationId: string): MetricsRefresh {
    expire();
    const now = d.now(),
      destination = d.destination(destinationId);
    const publications: PerformancePublication[] = [];
    for (const delivery of d
      .deliveries()
      .filter((x) => x.accountId === destinationId)) {
      const attribution = d.attribution(delivery.packageHash);
      if (
        !attribution ||
        attribution.attributionHash !== delivery.attribution.attributionHash ||
        attribution.accountId !== destinationId
      )
        throw Error("Publication metrics attribution integrity failure");
      for (const remoteId of delivery.publicationIds.length
        ? [...new Set(delivery.publicationIds)]
        : [undefined]) {
        const key = keyOf(
            delivery.platform,
            destinationId,
            remoteId ?? `pending:${delivery.id}`,
          ),
          stored = CacheSchema.safeParse(
            d.store.get("publication-metrics", key)?.value,
          );
        let metrics = empty(remoteId ? "not-refreshed" : "not-published", now);
        if (
          destination?.connected &&
          destination.id === destinationId &&
          destination.platform === delivery.platform &&
          stored.success &&
          stored.data.clientId === destination.clientId &&
          stored.data.accountId === destinationId &&
          stored.data.remoteId === remoteId
        )
          metrics = Object.fromEntries(
            METRIC_KEYS.map((k) => {
              const m = stored.data.metrics[k];
              return [
                k,
                m.availability === "available" && now - m.measuredAt >= TTL
                  ? unavailable(k, "expired", now)
                  : m.availability === "unavailable" &&
                      m.lastAvailable &&
                      now - m.lastAvailable.measuredAt >= TTL
                    ? { ...m, lastAvailable: undefined }
                    : m,
              ];
            }),
          ) as PublicationMetrics;
        const changes = z
          .array(RemoteChangeSchema)
          .max(20)
          .parse(
            d.store.get<{ changes: unknown }>("publication-observations", key)
              ?.value.changes ?? [],
          );
        const thumbnailAttribution = changes.length
          ? "uncertain"
          : delivery.thumbnail.status === "accepted" &&
              delivery.thumbnail.checksum ===
                delivery.selectedThumbnail?.checksum
            ? "accepted-unverified"
            : "selected-only";
        publications.push({
          key,
          remoteId,
          delivery,
          attribution,
          metrics,
          remoteChanges: changes,
          thumbnailAttribution,
        });
      }
    }
    return { destinationId, attemptedAt: now, status: "skipped", publications };
  }
  async function request(url: string, token: string, signal: AbortSignal) {
    if (signal.aborted) throw Error("Metrics refresh deadline");
    const res = await call(d.fetch, url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    const body = await readJson(res);
    if (!res.ok)
      throw Object.assign(Error("Publication metrics request failed"), {
        status: res.status,
        reason: JSON.stringify(body).match(/quota|dailyLimit/i)
          ? "quota"
          : res.status === 401 || res.status === 403
            ? "auth-required"
            : "request-failed",
      });
    return body;
  }
  async function refresh(destinationId: string): Promise<MetricsRefresh> {
    const attemptedAt = d.now(),
      snapshot = publicationMetrics(destinationId),
      initial = d.destination(destinationId);
    let gen = generation(destinationId);
    if (!initial?.connected || initial.id !== destinationId)
      return {
        ...snapshot,
        status: "unavailable",
        reason:
          "Connect the exact publishing destination to refresh its results.",
      };
    if (initial.platform !== "youtube")
      return {
        ...snapshot,
        status: "unavailable",
        reason:
          "Publication metrics for this platform require a separate capability and consent milestone.",
        publications: snapshot.publications.map((p) => ({
          ...p,
          metrics: empty("not-supported", attemptedAt),
        })),
      };
    gen = d.store.mutate(
      "performance-refresh",
      destinationId,
      () => ({ generation: 0 }),
      (x) => ({ generation: x.generation + 1 }),
    ).generation;
    const deadline = AbortSignal.timeout(30000);
    const samePrincipal = (
      a: MetricsDestination | undefined,
      b: MetricsDestination,
    ) =>
      !!a &&
      a.connected &&
      a.id === b.id &&
      a.platform === b.platform &&
      a.clientId === b.clientId;
    let baseline = initial,
      token: string;
    try {
      token = await d.token(destinationId);
      const current = d.destination(destinationId);
      if (!samePrincipal(current, initial) || generation(destinationId) !== gen)
        throw Error("Destination changed");
      baseline = current!;
    } catch {
      return {
        ...publicationMetrics(destinationId),
        status: "unavailable",
        reason:
          "Publishing destination changed or authentication is unavailable.",
      };
    }
    const current = () => {
      const a = d.destination(destinationId);
      return (
        samePrincipal(a, baseline) &&
        a?.epoch === baseline.epoch &&
        generation(destinationId) === gen
      );
    };
    const eligible = snapshot.publications.filter(
      (p) => p.remoteId && p.delivery.platform === "youtube",
    );
    // Oldest checked first: bounded continuation eventually refreshes every exact retained ID.
    eligible.sort(
      (a, b) =>
        Math.min(
          ...Object.values(a.metrics).map((m) =>
            m.availability === "available" ? m.measuredAt : m.checkedAt,
          ),
        ) -
        Math.min(
          ...Object.values(b.metrics).map((m) =>
            m.availability === "available" ? m.measuredAt : m.checkedAt,
          ),
        ),
    );
    const selected = eligible.slice(0, LIMIT);
    if (!selected.length)
      return { ...snapshot, status: "skipped", completedAt: d.now() };
    const updates = new Map<string, PublicationMetrics>();
    for (const p of selected)
      updates.set(p.key, empty("not-returned", attemptedAt));
    try {
      const body = await request(
        `https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: "snippet,statistics,status", id: [...new Set(selected.map((p) => p.remoteId!))].join(","), maxResults: "50" })}`,
        token,
        deadline,
      );
      if (!Array.isArray(body.items))
        throw Error("Invalid video metrics response");
      for (const p of selected) {
        const item = body.items.find(
          (v: unknown) =>
            !!v &&
            typeof v === "object" &&
            (v as { id?: unknown }).id === p.remoteId,
        ) as
          | {
              snippet?: { channelId?: string };
              statistics?: Record<string, unknown>;
            }
          | undefined;
        const metrics = updates.get(p.key)!;
        for (const k of ["views", "likes", "comments"] as const) {
          const value =
            item?.snippet?.channelId === destinationId
              ? rawNumber(item.statistics?.[values[k].api], true)
              : undefined;
          metrics[k] =
            value === undefined
              ? unavailable(k, "not-returned", attemptedAt, p.metrics[k])
              : {
                  availability: "available",
                  value,
                  metric: values[k].api,
                  unit: "count",
                  source: "youtube-data",
                  measuredAt: attemptedAt,
                  window: { kind: "lifetime" },
                  definitionVersion:
                    k === "views"
                      ? "play-starts-2026-08-24"
                      : "youtube-data-v3",
                };
        }
      }
    } catch (error) {
      const reason =
        (error as { reason?: MetricUnavailableReason }).reason ??
        "request-failed";
      for (const p of selected)
        for (const k of ["views", "likes", "comments"] as const)
          updates.get(p.key)![k] = unavailable(
            k,
            reason,
            attemptedAt,
            p.metrics[k],
          );
    }
    for (const p of selected) {
      if (!current()) break;
      const metrics = updates.get(p.key)!,
        keys = METRIC_KEYS.filter(
          (k) => !["views", "likes", "comments"].includes(k),
        );
      if (deadline.aborted) {
        for (const k of keys)
          metrics[k] = unavailable(
            k,
            "request-failed",
            attemptedAt,
            p.metrics[k],
          );
        continue;
      }
      if (
        !baseline.scope
          ?.split(/\s+/)
          .includes("https://www.googleapis.com/auth/yt-analytics.readonly")
      ) {
        for (const k of keys)
          metrics[k] = unavailable(
            k,
            "scope-missing",
            attemptedAt,
            p.metrics[k],
          );
        continue;
      }
      const startDay = pacificDay(
          p.delivery.publishedAt ?? p.delivery.firstPublicAt ?? attemptedAt,
        ),
        endDay = pacificDay(attemptedAt);
      try {
        // Provider computes the exact filtered interval; no local means/sums/ratios.
        const params = new URLSearchParams({
          ids: `channel==${destinationId}`,
          filters: `video==${p.remoteId}`,
          startDate: startDay,
          endDate: endDay,
          metrics:
            "views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage",
        });
        const body = await request(
          `https://youtubeanalytics.googleapis.com/v2/reports?${params}`,
          token,
          deadline,
        );
        const headers = Array.isArray(body.columnHeaders)
            ? (body.columnHeaders as { name?: string }[])
            : [],
          rows = body.rows;
        if (!headers.length || (rows !== undefined && !Array.isArray(rows)))
          throw Error("Invalid analytics report");
        // Aggregate report has no day dimension: return-through date is unknown, not invented.
        for (const k of keys) {
          const i = headers.findIndex((h) => h.name === values[k].api),
            row =
              Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0])
                ? rows[0]
                : undefined,
            value =
              i >= 0 && row
                ? rawNumber(row[i], values[k].unit === "count")
                : undefined;
          metrics[k] =
            value === undefined
              ? unavailable(
                  k,
                  i < 0 ? "not-returned" : "delayed-or-limited",
                  attemptedAt,
                  p.metrics[k],
                )
              : {
                  availability: "available",
                  value,
                  metric: values[k].api,
                  unit: values[k].unit,
                  source: "youtube-analytics",
                  measuredAt: attemptedAt,
                  window: {
                    kind: "calendar",
                    startDay,
                    requestedEndDay: endDay,
                    timezone: "America/Los_Angeles",
                    coverage: "unknown",
                  },
                  definitionVersion: "youtube-analytics-v2",
                };
        }
      } catch (error) {
        const reason =
          (error as { reason?: MetricUnavailableReason }).reason ??
          "invalid-response";
        for (const k of keys)
          metrics[k] = unavailable(k, reason, attemptedAt, p.metrics[k]);
      }
    }
    if (!current())
      return {
        ...publicationMetrics(destinationId),
        status: "unavailable",
        reason: "Destination or cached-results consent changed during refresh.",
      };
    d.store.transaction(() => {
      if (!current()) throw Error("Destination changed before metrics commit");
      for (const p of selected)
        d.store.put(
          "publication-metrics",
          p.key,
          CacheSchema.parse({
            version: 1,
            accountId: destinationId,
            platform: "youtube",
            remoteId: p.remoteId,
            clientId: baseline.clientId,
            checkedAt: attemptedAt,
            expiresAt: attemptedAt + TTL,
            metrics: updates.get(p.key),
          }),
        );
    });
    const result = publicationMetrics(destinationId),
      all = [...updates.values()].flatMap((m) => Object.values(m));
    return {
      ...result,
      attemptedAt,
      completedAt: d.now(),
      status: all.every((m) => m.availability === "available")
        ? "updated"
        : all.some((m) => m.availability === "available")
          ? "partial"
          : "unavailable",
      nextRefreshAt: attemptedAt + METRICS_STALE_MS,
      continuation: eligible.length > LIMIT,
    };
  }
  function refreshPublicationMetrics(destinationId: string) {
    const key = `${d.store.file}\n${destinationId}`;
    let p = inflight.get(key);
    if (!p) {
      p = refresh(destinationId).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }
  function recordRemoteChange(
    destinationId: string,
    remoteId: string,
    value: { kind: "thumbnail" | "media"; changedAt?: number },
  ) {
    const row = publicationMetrics(destinationId).publications.find(
      (p) => p.remoteId === remoteId,
    );
    if (!row) throw Error("Exact publication not found");
    const change = RemoteChangeSchema.parse({ ...value, reportedAt: d.now() });
    if (change.changedAt !== undefined && change.changedAt > d.now())
      throw Error("Change time is in the future");
    d.store.mutate(
      "publication-observations",
      row.key,
      () => ({ changes: [] as z.infer<typeof RemoteChangeSchema>[] }),
      (x) => ({ changes: [...x.changes, change].slice(-20) }),
    );
    return publicationMetrics(destinationId);
  }
  async function summarizeRecipePerformance(
    recipeId: string,
    destinationId?: string,
  ): Promise<RecipePerformance> {
    if (!/^[a-f0-9]{64}$/.test(recipeId))
      throw Error("Invalid immutable recipe ID");
    const ids = destinationId
      ? [destinationId]
      : [...new Set(d.deliveries().map((x) => x.accountId))];
    const publications = ids
      .filter((id) => {
        const a = d.destination(id);
        return a?.connected && a.id === id;
      })
      .flatMap((id) => publicationMetrics(id).publications)
      .filter(
        (p) =>
          p.attribution.recipe.state === "attributed" &&
          p.attribution.recipe.recipeId === recipeId,
      );
    return {
      recipeId,
      generatedAt: d.now(),
      publications,
      suggestions: localSuggestions(),
      comparison: {
        availability: "unavailable",
        reason:
          "Raw YouTube results are shown by exact recipe. API-derived rankings or lift require specific provider permission; causal improvement is unproven.",
      },
    };
  }
  return {
    publicationMetrics,
    refreshPublicationMetrics,
    purgePublicationMetrics,
    recordRemoteChange,
    summarizeRecipePerformance,
  };
}
export const refreshPublicationMetrics = (destinationId: string) =>
  createPerformanceService(defaultDeps()).refreshPublicationMetrics(
    destinationId,
  );
export const summarizeRecipePerformance = (
  recipeId: string,
  destinationId?: string,
) =>
  createPerformanceService(defaultDeps()).summarizeRecipePerformance(
    recipeId,
    destinationId,
  );
export const publicationMetrics = (destinationId: string) =>
  createPerformanceService(defaultDeps()).publicationMetrics(destinationId);
export const purgePublicationMetrics = (destinationId: string) =>
  createPerformanceService(defaultDeps()).purgePublicationMetrics(
    destinationId,
  );
export const recordRemoteChange = (
  destinationId: string,
  remoteId: string,
  value: { kind: "thumbnail" | "media"; changedAt?: number },
) =>
  createPerformanceService(defaultDeps()).recordRemoteChange(
    destinationId,
    remoteId,
    value,
  );
