import type { ChannelInfo, ChannelVideo } from "../lib/types";
import type { Upload } from "./youtube";

export interface DiscoveryVideo extends Upload {
  channelId?: string;
  privacy?: string;
  uploadStatus?: string;
  broadcast?: string;
  scheduledAt?: number;
  endedAt?: number;
}

/** Parsing for the YouTube Data and Analytics APIs (the user's own channel). Pure: server/channel.ts fetches. */

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" ? (v as J) : {});
const num = (v: unknown) =>
  v === undefined || v === null || v === "" ? undefined : Number(v);
const thumb = (t: unknown) => {
  const x = obj(t);
  return (obj(x.high).url ?? obj(x.medium).url ?? obj(x.default).url) as
    string | undefined;
};

/** ISO 8601 duration (PT1M4S) → seconds. */
export function isoDuration(s: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    s ?? "",
  );
  if (!m) return 0;
  return (
    Number(m[1] ?? 0) * 86400 +
    Number(m[2] ?? 0) * 3600 +
    Number(m[3] ?? 0) * 60 +
    Number(m[4] ?? 0)
  );
}

/** Publication evidence comes from videos.snippet, never a playlist insertion date. */
export function parseDiscoveryVideos(body: J): DiscoveryVideo[] {
  return ((body.items as unknown[] | undefined) ?? []).map((raw) => {
    const it = obj(raw),
      snippet = obj(it.snippet),
      status = obj(it.status);
    const live = obj(it.liveStreamingDetails);
    const date = (v: unknown) => {
      const n = Date.parse(String(v ?? ""));
      return Number.isFinite(n) ? n : undefined;
    };
    const duration = obj(it.contentDetails).duration;
    return {
      id: String(it.id),
      title: String(snippet.title ?? it.id),
      channelId: snippet.channelId as string | undefined,
      publishedAt: date(snippet.publishedAt),
      duration:
        typeof duration === "string" ? isoDuration(duration) : undefined,
      live: ["live", "upcoming"].includes(String(snippet.liveBroadcastContent)),
      broadcast: snippet.liveBroadcastContent as string | undefined,
      privacy: status.privacyStatus as string | undefined,
      uploadStatus: status.uploadStatus as string | undefined,
      scheduledAt: date(live.scheduledStartTime),
      endedAt: date(live.actualEndTime),
    };
  });
}

/** brandingSettings keywords: space separated, phrases in quotes. */
const channelKeywords = (s: unknown) =>
  [...String(s ?? "").matchAll(/"([^"]+)"|(\S+)/g)]
    .map((m) => (m[1] ?? m[2])!.trim())
    .filter(Boolean);

export function parseMyChannel(body: J): ChannelInfo | null {
  const it = obj((body.items as unknown[] | undefined)?.[0]);
  if (!it.id) return null;
  const sn = obj(it.snippet);
  const st = obj(it.statistics);
  return {
    id: String(it.id),
    title: String(sn.title ?? ""),
    handle: sn.customUrl as string | undefined,
    description: String(sn.description ?? ""),
    avatar: thumb(sn.thumbnails),
    subscribers: st.hiddenSubscriberCount ? undefined : num(st.subscriberCount),
    views: num(st.viewCount),
    videos: num(st.videoCount),
    uploads: obj(obj(obj(it.contentDetails).relatedPlaylists)).uploads as
      string | undefined,
    keywords: channelKeywords(obj(obj(it.brandingSettings).channel).keywords),
  };
}

export function parseVideoItems(body: J): ChannelVideo[] {
  return ((body.items as unknown[] | undefined) ?? []).map((raw) => {
    const it = obj(raw);
    const sn = obj(it.snippet);
    const st = obj(it.statistics);
    const status = obj(it.status);
    return {
      id: String(it.id),
      title: String(sn.title ?? ""),
      description: String(sn.description ?? ""),
      tags: (sn.tags as string[] | undefined) ?? [],
      publishedAt: Date.parse(String(sn.publishedAt ?? "")) || 0,
      categoryId: sn.categoryId as string | undefined,
      thumb: thumb(sn.thumbnails),
      duration: isoDuration(String(obj(it.contentDetails).duration ?? "")),
      views: num(st.viewCount),
      likes: num(st.likeCount),
      comments: num(st.commentCount),
      privacy: status.privacyStatus as string | undefined,
      madeForKids: status.madeForKids as boolean | undefined,
    };
  });
}

/** Analytics reports come as column headers + rows; return one object per row. */
export function parseAnalytics(body: J): Record<string, string | number>[] {
  const cols = (
    (body.columnHeaders as { name: string }[] | undefined) ?? []
  ).map((c) => c.name);
  return ((body.rows as unknown[][] | undefined) ?? []).map((r) =>
    Object.fromEntries(cols.map((c, i) => [c, r[i] as string | number])),
  );
}

const SCOPE = "https://www.googleapis.com/auth/";
/** What the stored token lets capy do: read the channel, read Analytics, edit videos. */
export function hasScopes(scope: string | undefined): {
  read: boolean;
  analytics: boolean;
  edit: boolean;
} {
  const s = new Set((scope ?? "").split(/\s+/).filter(Boolean));
  const edit = s.has(`${SCOPE}youtube.force-ssl`) || s.has(`${SCOPE}youtube`);
  return {
    read: edit || s.has(`${SCOPE}youtube.readonly`),
    analytics: s.has(`${SCOPE}yt-analytics.readonly`),
    edit,
  };
}

/** A plain-words message for the two refusals the user can act on, else null. */
export function quotaOrScope(status: number, body: J): string | null {
  const reason = String(
    obj(((obj(body.error).errors as unknown[] | undefined) ?? [])[0]).reason ??
      "",
  );
  if (
    /accessNotConfigured|SERVICE_DISABLED/i.test(reason) ||
    /has not been used in project|is disabled/i.test(
      String(obj(body.error).message ?? ""),
    )
  )
    return "Enable the YouTube Analytics API (and YouTube Data API v3) in your Google Cloud project: Settings → Posting accounts → setup guide.";
  if (/quota|dailyLimit/i.test(reason))
    return "YouTube's daily limit for API calls is used up. It resets at midnight Pacific time.";
  if (status === 403 && /insufficient|forbidden|scope/i.test(reason))
    return "Reconnect YouTube in Settings → Accounts to allow this (capy asks for Analytics and video editing access).";
  return null;
}
