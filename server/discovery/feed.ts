/**
 * A channel's public uploads feed (no account): its 15 newest videos with their exact upload times. The Videos tab
 * that account-free discovery reads has no dates, so this is what dates its newest uploads.
 */
export const feedUrl = (channelId: string) =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

/** videoId → upload time (ms) from an Atom feed body. */
export function parseFeedDates(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = /<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(entry!)?.[1];
    const at = Date.parse(/<published>([^<]+)<\/published>/.exec(entry!)?.[1] ?? "");
    if (id && Number.isFinite(at)) out.set(id, at);
  }
  return out;
}

/** Upload times for the channel's newest uploads; empty when the feed can't be read (never throws). */
export async function feedDates(
  channelId: string,
  signal: AbortSignal,
  f: typeof fetch = fetch,
): Promise<Map<string, number>> {
  try {
    const r = await f(feedUrl(channelId), { signal });
    return r.ok ? parseFeedDates(await r.text()) : new Map();
  } catch {
    return new Map();
  }
}
