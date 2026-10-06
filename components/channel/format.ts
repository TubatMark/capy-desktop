const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** 1234 → "1.2K"; missing → "—". */
export const num = (n: number | undefined | null) => (typeof n === "number" && Number.isFinite(n) ? compact.format(n) : "—");

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.round(d / 30);
  if (mo < 18) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  return `${Math.round(mo / 12)} years ago`;
}

export const shortDate = (t: number | string) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** YouTube Analytics traffic source ids → what a creator calls them. */
export const SOURCE_NAME: Record<string, string> = {
  SHORTS: "Shorts feed",
  YT_SEARCH: "YouTube search",
  RELATED_VIDEO: "Suggested videos",
  BROWSE: "Home and browse",
  SUBSCRIBER: "Subscriptions",
  YT_CHANNEL: "Your channel page",
  EXT_URL: "Other websites",
  NO_LINK_OTHER: "Direct or unknown",
  NO_LINK_EMBEDDED: "Embedded players",
  PLAYLIST: "Playlists",
  NOTIFICATION: "Notifications",
  YT_OTHER_PAGE: "Other YouTube pages",
  END_SCREEN: "End screens",
  HASHTAGS: "Hashtag pages",
  SOUND_PAGE: "Sound pages",
  VIDEO_REMIXES: "Remixes",
  ADVERTISING: "Ads",
  ANNOTATION: "Cards and annotations",
  CAMPAIGN_CARD: "Campaign cards",
  SHORTS_CONTENT_LINKS: "Links in Shorts",
  PRODUCT_PAGE: "Product pages",
  LIVE_REDIRECT: "Live redirects",
  IMMERSIVE_LIVE: "Live feed",
};
export const sourceName = (s: string) => SOURCE_NAME[s] ?? s.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
