import path from "node:path";
import type { ChannelSnapshot, ChannelVideo, SeoText } from "../lib/types";
import { hasScopes, parseAnalytics, parseMyChannel, parseVideoItems, quotaOrScope } from "../src/youtube-api";
import { scoreSeo, type SeoKind } from "../src/seo/score";
import { getAccessToken, loadAccounts } from "./accounts";
import { readJsonFile, saveJsonAtomic } from "./json-file";
import { call, readJson } from "./platforms/types";
import { dataDir } from "./settings";

/**
 * The user's own YouTube channel: its details, its uploads with their numbers, and (with the Analytics
 * permission) the last 28 days. Kept as a snapshot in <data>/channel.json so the page opens instantly.
 */

const DATA = "https://www.googleapis.com/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
/** A snapshot older than this is refreshed when the page asks for it. */
export const STALE_MS = 6 * 3600_000;
const MAX_VIDEOS = 200;

export interface ChannelDeps {
  fetch: typeof fetch;
  token(): Promise<string>;
  now(): Date;
}
const defaultDeps = (): ChannelDeps => ({ fetch, token: () => getAccessToken("youtube"), now: () => new Date() });

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function getJson(d: ChannelDeps, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await call(d.fetch, url, { ...init, headers: { Authorization: `Bearer ${await d.token()}`, ...(init?.headers ?? {}) } });
  const body = await readJson(res);
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined;
    throw new ApiError(quotaOrScope(res.status, body) ?? err?.message ?? `YouTube answered HTTP ${res.status}`, res.status);
  }
  return body;
}

const qs = (p: Record<string, string | number>) => new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Shorts are up to 3 minutes; made-for-kids videos get the kids checks. */
export const seoKindOf = (v: Pick<ChannelVideo, "duration" | "madeForKids">): SeoKind => (v.madeForKids ? "kids" : v.duration <= 180 ? "short" : "video");
export const videoText = (v: Pick<ChannelVideo, "title" | "description" | "tags">): SeoText => ({ title: v.title, description: v.description, hashtags: [], tags: v.tags });

export async function fetchVideos(d: ChannelDeps, ids: string[]): Promise<ChannelVideo[]> {
  const out: ChannelVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const body = await getJson(d, `${DATA}/videos?${qs({ part: "snippet,statistics,contentDetails,status", id: ids.slice(i, i + 50).join(","), maxResults: 50 })}`);
    out.push(...parseVideoItems(body));
  }
  for (const v of out) v.seo = scoreSeo(videoText(v), { kind: seoKindOf(v) }).score;
  return out;
}

/** Everything the channel page shows. Analytics parts that fail (or aren't allowed) become notes. */
export async function fetchSnapshot(d: ChannelDeps, scope: string | undefined): Promise<ChannelSnapshot> {
  const channel = parseMyChannel(await getJson(d, `${DATA}/channels?${qs({ part: "snippet,statistics,contentDetails,brandingSettings", mine: "true" })}`));
  if (!channel) throw new ApiError("This Google account has no YouTube channel yet.", 404);
  const notes: string[] = [];

  const ids: string[] = [];
  let page = "";
  while (channel.uploads && ids.length < MAX_VIDEOS) {
    const body = await getJson(d, `${DATA}/playlistItems?${qs({ part: "contentDetails", playlistId: channel.uploads, maxResults: 50, ...(page ? { pageToken: page } : {}) })}`);
    for (const it of (body.items as { contentDetails?: { videoId?: string } }[] | undefined) ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    page = String(body.nextPageToken ?? "");
    if (!page) break;
  }
  const videos = (await fetchVideos(d, ids.slice(0, MAX_VIDEOS))).sort((a, b) => b.publishedAt - a.publishedAt);

  let analytics: ChannelSnapshot["analytics"];
  if (hasScopes(scope).analytics) {
    const end = d.now();
    const start = new Date(end.getTime() - 28 * 86400_000);
    const base = { ids: "channel==MINE", startDate: isoDay(start), endDate: isoDay(end) };
    const report = async (p: Record<string, string | number>, what: string) => {
      try {
        return parseAnalytics(await getJson(d, `${ANALYTICS}?${qs({ ...base, ...p })}`));
      } catch (e) {
        notes.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    };
    const days = await report({ metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost", dimensions: "day", sort: "day" }, "Daily numbers");
    const perVideo = await report({ metrics: "views,estimatedMinutesWatched,averageViewPercentage", dimensions: "video", sort: "-views", maxResults: 200 }, "Per-video numbers");
    const sources = await report({ metrics: "views", dimensions: "insightTrafficSourceType", sort: "-views" }, "Traffic sources");
    const searches = await report({ metrics: "views", dimensions: "insightTrafficSourceDetail", filters: "insightTrafficSourceType==YT_SEARCH", sort: "-views", maxResults: 25 }, "Search terms");
    const byId = new Map(videos.map((v) => [v.id, v]));
    let watched = 0;
    let weight = 0;
    for (const r of perVideo) {
      const v = byId.get(String(r.video));
      const pct = Number(r.averageViewPercentage);
      if (v) Object.assign(v, { minutes: Number(r.estimatedMinutesWatched), avgViewPct: pct });
      if (Number.isFinite(pct)) {
        watched += pct * Number(r.views);
        weight += Number(r.views);
      }
    }
    analytics = {
      days: days.map((r) => ({ day: String(r.day), views: Number(r.views), minutes: Number(r.estimatedMinutesWatched), subsGained: Number(r.subscribersGained), subsLost: Number(r.subscribersLost) })),
      sources: sources.map((r) => ({ source: String(r.insightTrafficSourceType), views: Number(r.views) })),
      searches: searches.map((r) => ({ term: String(r.insightTrafficSourceDetail), views: Number(r.views) })),
      avgViewPct: weight ? watched / weight : undefined,
    };
  } else {
    notes.push("Reconnect YouTube in Settings → Accounts to see watch time, traffic sources and the searches that found you.");
  }
  return { channel, videos, analytics, notes, fetchedAt: d.now().getTime() };
}

/** Change a video's title, description and tags on YouTube, keeping the rest of its snippet. */
export async function updateVideoText(d: ChannelDeps, id: string, t: { title: string; description: string; tags: string[] }): Promise<ChannelVideo> {
  const cur = (await getJson(d, `${DATA}/videos?${qs({ part: "snippet", id })}`)).items as { snippet?: Record<string, unknown> }[] | undefined;
  const sn = cur?.[0]?.snippet;
  if (!sn) throw new ApiError("That video isn't on your channel any more.", 404);
  const keep = Object.fromEntries(["categoryId", "defaultLanguage", "defaultAudioLanguage"].filter((k) => sn[k] !== undefined).map((k) => [k, sn[k]]));
  await getJson(d, `${DATA}/videos?part=snippet`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, snippet: { ...keep, categoryId: keep.categoryId ?? "22", title: t.title.slice(0, 100), description: t.description.slice(0, 5000), tags: t.tags } }),
  });
  const [v] = await fetchVideos(d, [id]);
  if (!v) throw new ApiError("YouTube didn't return the updated video.", 502);
  return v;
}

// ---------- the stored snapshot ----------

export const channelFile = () => path.join(dataDir(), "channel.json");
export const loadSnapshot = () => readJsonFile<ChannelSnapshot>(channelFile());

export function channelAccess() {
  const a = loadAccounts().youtube ?? {};
  const connected = !!a.tokens?.accessToken && !a.needsReconnect;
  return { connected, ...hasScopes(connected ? a.tokens?.scope : undefined) };
}

declare global {
  // eslint-disable-next-line no-var
  var __capyChannelRefresh: Promise<ChannelSnapshot> | undefined;
}

/**
 * The snapshot for the page: the saved one, refreshed first when asked or stale. A failed refresh keeps the saved
 * snapshot and reports why. One refresh at a time.
 */
export async function channelState(o: { refresh?: boolean } = {}, d: ChannelDeps = defaultDeps()) {
  const access = channelAccess();
  let snapshot = await loadSnapshot();
  let error: string | undefined;
  if (access.connected && (o.refresh || !snapshot || d.now().getTime() - snapshot.fetchedAt > STALE_MS)) {
    try {
      globalThis.__capyChannelRefresh ??= fetchSnapshot(d, loadAccounts().youtube?.tokens?.scope).finally(() => (globalThis.__capyChannelRefresh = undefined));
      snapshot = await globalThis.__capyChannelRefresh;
      await saveJsonAtomic(channelFile(), snapshot);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { access, snapshot, error };
}

/** After an edit on YouTube: the saved snapshot shows the new text right away. */
export async function replaceVideo(v: ChannelVideo) {
  // a refresh that started before the edit would save the old text over it: apply the edit after it
  await globalThis.__capyChannelRefresh?.catch(() => {});
  const s = await loadSnapshot();
  if (!s) return;
  const i = s.videos.findIndex((x) => x.id === v.id);
  if (i < 0) return;
  s.videos[i] = { ...s.videos[i], ...v, minutes: s.videos[i]!.minutes, avgViewPct: s.videos[i]!.avgViewPct };
  await saveJsonAtomic(channelFile(), s);
}
