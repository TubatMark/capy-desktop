import path from "node:path";
import type { ChannelVideo, KeywordResearch, RankVideo, SeoReport, SeoText, VideoSeoSuggestion } from "../lib/types";
import { mergeKeywords, pacificDay, parseSuggest, suggestedTags } from "../src/seo/keywords";
import { optimizeSeo, seedPhrases, type AiOpts } from "../src/seo/optimize";
import { scoreSeo, type SeoKind } from "../src/seo/score";
import { parseVideoItems } from "../src/youtube-api";
import { getAccessToken } from "./accounts";
import { channelAccess, loadSnapshot, seoKindOf, videoText } from "./channel";
import { readJsonFile, saveJsonAtomic } from "./json-file";
import { dataDir, effective } from "./settings";

/**
 * Keyword research and SEO tuning. Autocomplete is free; a YouTube search costs 100 of the 10,000 daily API
 * units (an upload costs 1,600), so searches are cached for a week and capped per Pacific day.
 */

export const SEARCHES_PER_DAY = 25;
const SUGGEST_TTL = 3 * 86400_000;
const SEARCH_TTL = 7 * 86400_000;

interface Cache {
  day: string;
  searches: number;
  suggest: Record<string, { at: number; terms: string[] }>;
  search: Record<string, { at: number; ranking: RankVideo[] }>;
}

export interface SeoDeps {
  fetch: typeof fetch;
  /** null when YouTube isn't connected (research then skips the ranking search). */
  token(): Promise<string | null>;
  now(): Date;
  cacheFile(): string;
}
const defaultDeps = (): SeoDeps => ({
  fetch,
  token: async () => (channelAccess().connected ? getAccessToken("youtube").catch(() => null) : null),
  now: () => new Date(),
  cacheFile: () => path.join(dataDir(), "seo-cache.json"),
});

declare global {
  // eslint-disable-next-line no-var
  var __capySeoCache: { file: string; data: Promise<Cache> } | undefined;
  // eslint-disable-next-line no-var
  var __capySeoSearches: Map<string, Promise<RankVideo[] | "quota">> | undefined;
}

async function cache(d: SeoDeps): Promise<Cache> {
  const file = d.cacheFile();
  // one load per file, shared by concurrent callers, so no one's counts or entries get lost
  if (globalThis.__capySeoCache?.file !== file) globalThis.__capySeoCache = { file, data: readJsonFile<Cache>(file).then((d) => d ?? { day: "", searches: 0, suggest: {}, search: {} }) };
  const c = await globalThis.__capySeoCache.data;
  const today = pacificDay(d.now());
  if (c.day !== today) Object.assign(c, { day: today, searches: 0 });
  // drop expired entries so the file stays small
  const now = d.now().getTime();
  for (const [k, v] of Object.entries(c.suggest)) if (now - v.at > SUGGEST_TTL) delete c.suggest[k];
  for (const [k, v] of Object.entries(c.search)) if (now - v.at > SEARCH_TTL) delete c.search[k];
  return c;
}

const norm = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

async function suggest(d: SeoDeps, c: Cache, q: string): Promise<string[]> {
  const hit = c.suggest[q];
  if (hit) return hit.terms;
  const url = `https://suggestqueries.google.com/complete/search?${new URLSearchParams({ client: "firefox", ds: "yt", hl: "en", gl: "US", q })}`;
  const res = await d.fetch(url);
  if (!res.ok) throw new Error(`autocomplete HTTP ${res.status}`);
  const terms = parseSuggest(JSON.parse(await res.text()));
  c.suggest[q] = { at: d.now().getTime(), terms };
  return terms;
}

/** One YouTube search per query at a time: a second caller waits for the first instead of paying again. */
function ranking(d: SeoDeps, c: Cache, q: string, token: string): Promise<RankVideo[] | "quota"> {
  const inflight = (globalThis.__capySeoSearches ??= new Map());
  const k = `${d.cacheFile()}\n${q}`;
  let p = inflight.get(k);
  if (!p) {
    p = searchOnce(d, c, q, token).finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

async function searchOnce(d: SeoDeps, c: Cache, q: string, token: string): Promise<RankVideo[] | "quota"> {
  const hit = c.search[q];
  if (hit) return hit.ranking;
  if (c.searches >= SEARCHES_PER_DAY) return "quota";
  c.searches++;
  const auth = { Authorization: `Bearer ${token}` };
  const s = await d.fetch(`https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({ part: "snippet", type: "video", q, maxResults: "10", regionCode: "US", relevanceLanguage: "en" })}`, { headers: auth });
  const sb = (await s.json().catch(() => ({}))) as { items?: { id?: { videoId?: string }; snippet?: { channelTitle?: string } }[] };
  if (!s.ok) throw new Error(`search HTTP ${s.status}`);
  const items = sb.items ?? [];
  const ids = items.map((i) => i.id?.videoId).filter((x): x is string => !!x);
  const channels = new Map(items.map((i) => [i.id?.videoId, i.snippet?.channelTitle ?? ""]));
  let videos: RankVideo[] = [];
  if (ids.length) {
    const v = await d.fetch(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: "snippet,statistics,contentDetails,status", id: ids.join(",") })}`, { headers: auth });
    const vb = (await v.json().catch(() => ({}))) as Record<string, unknown>;
    if (!v.ok) throw new Error(`videos HTTP ${v.status}`);
    const byId = new Map(parseVideoItems(vb).map((x) => [x.id, x]));
    videos = ids.flatMap((id) => {
      const x = byId.get(id);
      return x ? [{ id, title: x.title, channel: channels.get(id) ?? "", views: x.views, publishedAt: x.publishedAt, tags: x.tags, thumb: x.thumb }] : [];
    });
  }
  c.search[q] = { at: d.now().getTime(), ranking: videos };
  return videos;
}

/** Local text heuristics, not observed publication lift. Scored keywords for a topic from autocomplete, what ranks, and the channel's own search terms. */
export async function research(seedRaw: string, o: { search?: boolean } = {}, d: SeoDeps = defaultDeps()): Promise<KeywordResearch> {
  const seed = norm(seedRaw);
  const c = await cache(d);
  const notes: string[] = [];
  const sug: string[] = [];
  for (const q of [seed, `${seed} for`]) {
    try {
      for (const t of await suggest(d, c, q)) if (!sug.includes(t)) sug.push(t);
    } catch (e) {
      notes.push(`YouTube autocomplete didn't answer (${e instanceof Error ? e.message : String(e)}).`);
      break;
    }
  }
  let rank: RankVideo[] = [];
  if (o.search !== false) {
    const token = await d.token();
    if (!token) notes.push("Connect YouTube to see what ranks for this search.");
    else {
      try {
        const r = await ranking(d, c, seed, token);
        if (r === "quota") notes.push(`Today's ${SEARCHES_PER_DAY} YouTube searches are used (they protect your upload quota); ranking videos come back tomorrow.`);
        else rank = r;
      } catch (e) {
        notes.push(`YouTube search failed (${e instanceof Error ? e.message : String(e)}).`);
      }
    }
  }
  const yours = (await loadSnapshot())?.analytics?.searches ?? [];
  await saveJsonAtomic(d.cacheFile(), c).catch(() => {});
  return { seed, keywords: mergeKeywords({ seed, suggest: sug, ranking: rank, yours }), ranking: rank, tags: suggestedTags(rank), notes, at: d.now().getTime() };
}

/** The channel's own top search terms (for the optimizer's context). */
export async function channelTerms(): Promise<string[]> {
  return ((await loadSnapshot())?.analytics?.searches ?? []).map((s) => s.term);
}

/** The AI the user picked in Settings. */
export function appAi(): AiOpts {
  const app = effective();
  return { agent: app.agent, model: app.agent === "claude" ? app.model : app.models[app.agent] };
}

/** Research the video's topic and rewrite its text; the user compares both and decides what goes to YouTube. */
export async function suggestForVideo(v: ChannelVideo, ai: AiOpts): Promise<VideoSeoSuggestion> {
  const kind = seoKindOf(v);
  const text = videoText(v);
  const about = `${v.title}\n${v.description}`.slice(0, 1500);
  const seeds = await seedPhrases({ kind, text, about }, ai);
  const res = seeds[0] ? await research(seeds[0]) : undefined;
  for (const s of seeds.slice(1)) {
    const more = await research(s, { search: false }).catch(() => null);
    if (res && more) for (const k of more.keywords) if (!res.keywords.some((x) => x.term === k.term)) res.keywords.push(k);
  }
  res?.keywords.sort((a, b) => b.score - a.score);
  const out = await optimizeSeo({ kind, text, about, research: res, channelTerms: await channelTerms() }, ai);
  return { videoId: v.id, keyword: out.rewriteReport.keyword, current: text, suggested: out.rewrite, before: { ...scoreSeo(text, { kind, keyword: out.rewriteReport.keyword }), at: Date.now() }, after: out.rewriteReport, research: res };
}

/** The description as it goes to YouTube: hashtags on its last line if they aren't in it already. */
export function withHashtags(t: SeoText): string {
  const missing = t.hashtags.map((h) => h.replace(/^#/, "")).filter((h) => h && !new RegExp(`#${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t.description));
  return missing.length ? `${t.description.trim()}\n\n${missing.map((h) => `#${h}`).join(" ")}` : t.description.trim();
}

export type Publish = { ytTitle: string; description: string; hashtags: string[]; tags?: string[] };

/**
 * Research + rewrite for an upload that's about to reach the queue. Never throws: if anything fails, the original
 * text goes on and the report says why.
 */
export async function tuneSeo(
  i: { kind: SeoKind; publish: Publish; about: string; seeds?: string[]; keep?: string },
  ai: AiOpts,
  dep: { research?: typeof research; seedPhrases?: typeof seedPhrases; optimizeSeo?: typeof optimizeSeo } = {},
): Promise<{ publish: Publish; seo: SeoReport }> {
  const text: SeoText = { title: i.publish.ytTitle, description: i.publish.description, hashtags: i.publish.hashtags, tags: i.publish.tags ?? [] };
  try {
    const seeds = i.seeds?.length ? i.seeds : await (dep.seedPhrases ?? seedPhrases)({ kind: i.kind, text, about: i.about }, ai).catch(() => [] as string[]);
    const res = seeds[0] ? await (dep.research ?? research)(seeds[0]) : undefined;
    // the other seeds only add autocomplete terms (no search quota)
    for (const s of seeds.slice(1)) {
      const more = await (dep.research ?? research)(s, { search: false }).catch(() => null);
      if (res && more) for (const k of more.keywords) if (!res.keywords.some((x) => x.term === k.term)) res.keywords.push(k);
    }
    res?.keywords.sort((a, b) => b.score - a.score);
    const out = await (dep.optimizeSeo ?? optimizeSeo)({ kind: i.kind, text, about: i.about, research: res, channelTerms: await channelTerms(), keep: i.keep }, ai);
    const t = out.text;
    return {
      publish: { ytTitle: t.title, description: t.description, hashtags: t.hashtags, tags: t.tags },
      seo: { ...out.report, note: [out.improved ? undefined : "The rewrite didn't score higher, so the original text stays.", ...(res?.notes ?? [])].filter(Boolean).join(" ") || undefined },
    };
  } catch (e) {
    const s = scoreSeo(text, { kind: i.kind });
    return { publish: i.publish, seo: { ...s, at: Date.now(), note: `SEO tuning didn't run (${e instanceof Error ? e.message.split("\n")[0] : String(e)}).` } };
  }
}
