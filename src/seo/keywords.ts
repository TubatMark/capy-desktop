import type { Keyword, RankVideo } from "../../lib/types";

/** Raw research helpers. No API-derived weighting, strength or shared-tag metrics. */

/** The autocomplete endpoint (client=firefox) answers ["query", ["suggestion", …]]. */
export function parseSuggest(body: unknown): string[] {
  if (!Array.isArray(body) || !Array.isArray(body[1])) return [];
  return (body[1] as unknown[]).filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim());
}

/** Raw autocomplete terms only. API video/Analytics inputs are never ranked or combined. */
export function mergeKeywords(i: { seed: string; suggest: string[]; ranking: RankVideo[]; yours: { term: string; views: number }[] }): Keyword[] {
  return [...new Set(i.suggest)].map((term) => ({ term, sources: ["autocomplete"] }));
}
/** Retained compatibility boundary: shared-tag aggregation is unsupported. */
export function suggestedTags(_ranking: RankVideo[]): string[] { return []; }

/** Google resets the YouTube API quota at midnight Pacific time. */
export function pacificDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
