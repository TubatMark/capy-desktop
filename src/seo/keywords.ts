import type { Keyword, RankVideo } from "../../lib/types";
import { matchesKeyword } from "./score";

/**
 * Keyword research from free sources: YouTube's autocomplete, what ranks for a search, and the searches that
 * already bring the channel viewers. These are the pure parts; server/seo.ts does the fetching and caching.
 */

/** The autocomplete endpoint (client=firefox) answers ["query", ["suggestion", …]]. */
export function parseSuggest(body: unknown): string[] {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return [];
  return (body[1] as unknown[]).filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim());
}

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Tags that more than one ranking video uses, most common first. */
export function suggestedTags(ranking: RankVideo[]): string[] {
  const count = new Map<string, number>();
  for (const v of ranking) for (const t of new Set((v.tags ?? []).map(key).filter(Boolean))) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/**
 * One scored list from every source. A term scores for an early autocomplete spot (people type it), for showing
 * up in what ranks (titles and shared tags), for already bringing this channel viewers, and for being seen in
 * more than one place.
 */
export function mergeKeywords(i: { seed: string; suggest: string[]; ranking: RankVideo[]; yours: { term: string; views: number }[] }): Keyword[] {
  type Acc = { term: string; sources: Set<Keyword["sources"][number]>; auto?: number; views?: number; hits: number; tagN: number };
  const all = new Map<string, Acc>();
  const get = (term: string) => {
    const k = key(term);
    let a = all.get(k);
    if (!a) all.set(k, (a = { term: k, sources: new Set(), hits: 0, tagN: 0 }));
    return a;
  };
  i.suggest.forEach((t, n) => {
    const a = get(t);
    a.sources.add("autocomplete");
    a.auto = Math.min(a.auto ?? Infinity, n);
  });
  for (const y of i.yours) {
    const a = get(y.term);
    a.sources.add("yours");
    a.views = (a.views ?? 0) + y.views;
  }
  const shared = new Map(suggestedTags(i.ranking).map((t) => [t, 0]));
  for (const v of i.ranking) for (const t of new Set((v.tags ?? []).map(key))) if (shared.has(t)) shared.set(t, shared.get(t)! + 1);
  for (const [t] of shared) get(t);
  for (const a of all.values()) {
    a.hits = i.ranking.filter((v) => matchesKeyword(v.title, a.term)).length;
    a.tagN = shared.get(a.term) ?? 0;
    if (a.hits || a.tagN) a.sources.add("ranking");
  }

  const n = Math.max(1, i.suggest.length);
  const r = Math.max(1, i.ranking.length);
  const maxViews = Math.max(1, ...i.yours.map((y) => y.views));
  const out: Keyword[] = [...all.values()]
    .filter((a) => a.sources.size)
    .map((a) => {
      const auto = a.auto === undefined ? 0 : 35 * (1 - a.auto / n);
      const rank = 40 * Math.min(1, (a.hits + a.tagN) / (2 * r));
      const yours = a.views === undefined ? 0 : 10 + 15 * (a.views / maxViews);
      const score = Math.round(Math.min(100, auto + rank + yours + 10 * (a.sources.size - 1)));
      return { term: a.term, score, sources: [...a.sources], ...(a.views !== undefined ? { views: a.views } : {}) };
    });
  return out.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term)).slice(0, 40);
}

/** Google resets the YouTube API quota at midnight Pacific time. */
export function pacificDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
