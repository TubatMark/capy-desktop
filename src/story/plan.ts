import { z } from "zod";
import { askAgent } from "../agents";
import type { KeywordResearch, StoryPlan, StorySeries } from "../../lib/types";
import type { AiOpts } from "./write";

/**
 * The plan, made at the brief before a word is written. Made-for-kids videos get no comments, no bell and
 * narrower recommendations, so reach comes from what parents search, the first two seconds, replays, and a series
 * worth coming back to. Persuasion is never aimed at children.
 */

const BAND: Record<StorySeries["ageBand"], { pages: [number, number] }> = { "2-4": { pages: [6, 8] }, "5-8": { pages: [8, 10] } };
export const pageRange = (s: Pick<StorySeries, "ageBand">) => BAND[s.ageBand].pages;

const PlanSchema = z.object({
  keyword: z.string().describe("The one search phrase parents type that this story should rank for (from the research when it fits)"),
  searchTerms: z.array(z.string()).describe("3-6 related searches for tags"),
  title: z.string().describe("Searchable, warm title for parents: the story's name plus the keyword, e.g. 'Pip Learns to Share | Bedtime Story for Toddlers'. Max 70 characters"),
  hook: z.object({
    line: z.string().describe("Page 1's opening line: instantly promises a story (a surprise, a wish, a funny problem), in the age band's word limit"),
    picture: z.string().describe("Page 1's picture: one bold, warm, uncluttered image that also works as the cover"),
  }),
  beats: z.object({ setup: z.string(), problem: z.string(), turn: z.string(), ending: z.string().describe("Warm, calm ending that calls back to the opening so it invites a replay") }),
  refrain: z.string().optional().describe("For ages 2-4: a short repeated line kids join in on"),
  pages: z.number().int(),
  targetSeconds: z.number().describe("Total length, 30-60 seconds"),
  parentsWhy: z.string().describe("One sentence: why a parent would pick this and play it again"),
});

export function planPrompt(series: StorySeries, brief: string, research?: KeywordResearch): string {
  const [lo, hi] = pageRange(series);
  const kws = research?.keywords.slice(0, 12).map((k) => `- ${k.term} (score ${k.score}${k.views ? `, already brings this channel ${k.views} views` : ""})`) ?? [];
  const ranks = research?.ranking.slice(0, 6).map((v) => `- "${v.title}"${v.views !== undefined ? ` (${v.views.toLocaleString("en-US")} views)` : ""}`) ?? [];
  return `Plan a 1-minute animated read-aloud Short for the kids' series "${series.title}" (ages ${series.ageBand}; tone: ${series.tone}; values: ${series.values.join(", ") || "kindness"}).
Characters: ${series.characters.map((c) => `${c.name} (${c.description})`).join("; ")}

Story idea: ${brief}
${kws.length ? `\nWhat parents search (best first):\n${kws.join("\n")}\n` : ""}${ranks.length ? `\nWhat ranks for "${research!.seed}" now:\n${ranks.join("\n")}\n` : ""}
It is posted as made for kids: no comments, no notifications, narrower recommendations. Plan for what still works:
- search: a title and keyword parents actually type;
- the first two seconds: page 1 must stop the scroll with a bold picture and an opening line that promises a story;
- replays: a refrain or repetition little ones love, and an ending that calls back to the opening;
- the series: something parents want more of.
${lo}-${hi} pages, 30-60 seconds read aloud. Original, safe, calm. Write for parents; never address or pressure children (no "subscribe", no "ask your parents").`;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The story's own name (title card, story list): the planned search title before any " | keyword" part. */
export const storyName = (searchTitle: string) => searchTitle.split(/\s+[|–—-]\s+/)[0]!.trim() || searchTitle.trim();

/** Clean the planner's answer; pages and length are kept inside the age band. */
export function normalizePlan(raw: unknown, series: StorySeries, notes?: string[]): StoryPlan {
  const r = (raw ?? {}) as Record<string, unknown>;
  const hook = (r.hook ?? {}) as Record<string, unknown>;
  const beats = (r.beats ?? {}) as Record<string, unknown>;
  const title = str(r.title);
  if (!title || !str(hook.line)) throw new Error("The AI's plan had no title or opening line");
  const [lo, hi] = pageRange(series);
  const pages = Number(r.pages);
  const secs = Number(r.targetSeconds);
  const keyword = str(r.keyword).toLowerCase();
  return {
    keyword,
    // related searches only: the keyword itself and repeats are dropped
    searchTerms: [...new Set((Array.isArray(r.searchTerms) ? r.searchTerms : []).map((t) => str(t).toLowerCase()).filter((t) => t && t !== keyword))].slice(0, 6),
    title: title.slice(0, 100),
    hook: { line: str(hook.line), picture: str(hook.picture) },
    beats: { setup: str(beats.setup), problem: str(beats.problem), turn: str(beats.turn), ending: str(beats.ending) },
    ...(str(r.refrain) ? { refrain: str(r.refrain) } : {}),
    pages: Number.isFinite(pages) ? Math.min(hi, Math.max(lo, Math.round(pages))) : lo + 1,
    targetSeconds: Number.isFinite(secs) ? Math.min(60, Math.max(30, Math.round(secs))) : 45,
    parentsWhy: str(r.parentsWhy),
    ...(notes?.length ? { notes } : {}),
    at: Date.now(),
  };
}

export async function planStory(series: StorySeries, brief: string, research: KeywordResearch | undefined, o: AiOpts): Promise<StoryPlan> {
  const { $schema: _d, ...schema } = z.toJSONSchema(PlanSchema, { target: "draft-7" }) as Record<string, unknown>;
  void _d;
  const res = await askAgent(o.agent, planPrompt(series, brief, research), {
    model: o.model,
    maxTurns: 2,
    effort: "medium",
    system: "You plan children's story Shorts that parents find and replay. Honest, warm, never manipulative. Answer only with the requested JSON.",
    schema,
    timeoutMs: 150_000,
  });
  return normalizePlan(res.data, series, research?.notes);
}
