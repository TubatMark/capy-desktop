import { z } from "zod";
import { askAgent } from "../agents";
import type { StoryAssessment, StorySeries, StoryState } from "../../lib/types";
import { scoreSeo } from "../seo/score";
import { pageRange } from "./plan";
import type { AiOpts } from "./write";

/**
 * The assessor: before a story's script or video reaches the user, five scores and a verdict. Hook and retention
 * are the AI's judgement; search, safety and production are measured.
 */

type Stage = StoryAssessment["stage"];
type Scores = StoryAssessment["scores"];

const WORDS: Record<StorySeries["ageBand"], number> = { "2-4": 15, "5-8": 30 };
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** Pages in the band (40), words per page within the limit (40), then scenes (script) or length + pictures (video) (20). */
export function productionScore(st: Pick<StoryState, "pages" | "video">, series: Pick<StorySeries, "ageBand">, stage: Stage): number {
  const [lo, hi] = pageRange(series);
  const n = st.pages.length;
  const dist = n < lo ? lo - n : n > hi ? n - hi : 0;
  const pages = 40 * Math.max(0, 1 - dist / 3);
  const within = n ? st.pages.filter((p) => words(p.text) <= WORDS[series.ageBand]).length / n : 0;
  let last: number;
  if (stage === "script") last = n && st.pages.every((p) => p.scene.trim()) ? 20 : 0;
  else {
    const d = st.video?.duration ?? 0;
    last = (d >= 25 && d <= 65 ? 10 : 0) + (n && st.pages.every((p) => p.status === "ready") ? 10 : 0);
  }
  return Math.round(pages + 40 * within + last);
}

const REVIEW = { ok: 100, fix: 60, block: 0 } as const;
const CONTENT = { ok: 100, caution: 60, block: 0 } as const;

/** The stricter of the kid-safety story reviewer and (at video stage) the content reviewer; unreviewed = 50. */
export function safetyScore(st: Pick<StoryState, "review" | "contentReview">, stage: Stage): number {
  const story = st.review ? REVIEW[st.review.verdict] : 50;
  if (stage === "script") return story;
  return Math.min(story, st.contentReview ? CONTENT[st.contentReview.verdict] : 50);
}

/** Script stage: the planned title against the planned keyword (title checks only). Video stage: the upload text's score. */
export function searchScore(st: Pick<StoryState, "plan" | "title" | "seo" | "publish">, stage: Stage): number {
  if (stage === "video") {
    if (st.seo) return st.seo.score;
    const p = st.publish;
    return p ? scoreSeo({ title: p.ytTitle, description: p.description, hashtags: p.hashtags, tags: p.tags ?? [] }, { kind: "kids" }).score : 0;
  }
  const r = scoreSeo({ title: st.plan?.title ?? st.title, description: "", hashtags: [], tags: [] }, { keyword: st.plan?.keyword || undefined, kind: "kids" });
  const title = r.checks.filter((c) => c.id.startsWith("title-"));
  const total = title.reduce((n, c) => n + c.weight, 0);
  return total ? Math.round((title.reduce((n, c) => n + (c.pass ? c.weight : 0), 0) / total) * 100) : 0;
}

const WEIGHTS: Scores = { hook: 25, retention: 25, search: 20, safety: 20, production: 10 };

export function combineScores(s: Scores): { overall: number; verdict: StoryAssessment["verdict"] } {
  const overall = Math.round((Object.keys(WEIGHTS) as (keyof Scores)[]).reduce((n, k) => n + (s[k] * WEIGHTS[k]) / 100, 0));
  return { overall, verdict: s.safety === 0 ? "block" : overall >= 75 && s.safety >= 80 ? "ready" : "fix" };
}

const Judgement = z.object({
  hook: z.object({ score: z.number().describe("0-100: does page 1 (words + picture) stop the scroll and promise a story?"), note: z.string() }),
  retention: z.object({ score: z.number().describe("0-100: does every page move the story, with repetition little ones love and an ending that invites a replay?"), note: z.string() }),
  strengths: z.array(z.string()).describe("Up to 3 things that work, short"),
  fixes: z.array(z.object({ area: z.string().describe("hook | retention | search | safety | pacing | pictures"), note: z.string().describe("A concrete change, page-numbered") })).describe("Up to 4, most important first; empty if nothing matters"),
});

const score = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v))) : 50);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function normalizeAssessment(raw: unknown): { hook: number; retention: number; strengths: string[]; fixes: { area: string; note: string }[] } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const part = (k: string) => ((r[k] ?? {}) as Record<string, unknown>).score;
  return {
    hook: score(part("hook")),
    retention: score(part("retention")),
    strengths: (Array.isArray(r.strengths) ? r.strengths : []).map(text).filter(Boolean).slice(0, 3),
    fixes: (Array.isArray(r.fixes) ? r.fixes : [])
      .map((f) => ({ area: text((f as Record<string, unknown>)?.area) || "story", note: text((f as Record<string, unknown>)?.note) }))
      .filter((f) => f.note)
      .slice(0, 4),
  };
}

export function assessPrompt(series: StorySeries, st: StoryState, stage: Stage): string {
  const p = st.plan;
  return `Assess this 1-minute read-aloud story Short for the kids' series "${series.title}" (ages ${series.ageBand}) before its creator sees it${stage === "video" ? " (the video is made)" : " (the script, before pictures are drawn)"}.
It's posted as made for kids, so reach comes from parents' searches, the first two seconds, replays and the series. Judge as a children's-media producer: warm, honest, never manipulative.
${p ? `\nThe plan: keyword "${p.keyword}"; hook "${p.hook.line}" / ${p.hook.picture}; ending: ${p.beats.ending}${p.refrain ? `; refrain "${p.refrain}"` : ""}.\n` : ""}
Title: ${st.title}
${st.pages.map((pg, i) => `Page ${i + 1}: ${pg.text}\n  (picture: ${pg.scene})`).join("\n")}
${stage === "video" && st.publish ? `\nUpload title: ${st.publish.ytTitle}\nDescription: ${st.publish.description}\nLength: ${Math.round(st.video?.duration ?? 0)} s\n` : ""}
Score the hook and retention (0-100, be honest: 75+ means it's genuinely good). List up to 3 strengths and up to 4 concrete fixes, most important first.`;
}

/** The full assessment for a stage. */
export async function assessStory(series: StorySeries, st: StoryState, stage: Stage, o: AiOpts): Promise<StoryAssessment> {
  const { $schema: _d, ...schema } = z.toJSONSchema(Judgement, { target: "draft-7" }) as Record<string, unknown>;
  void _d;
  const res = await askAgent(o.agent, assessPrompt(series, st, stage), {
    model: o.model,
    maxTurns: 2,
    effort: "medium",
    system: "You assess children's story videos before they're published. Specific, honest, kind. Answer only with the requested JSON.",
    schema,
    timeoutMs: 150_000,
  });
  const j = normalizeAssessment(res.data);
  const scores: Scores = { hook: j.hook, retention: j.retention, search: searchScore(st, stage), safety: safetyScore(st, stage), production: productionScore(st, series, stage) };
  const fixes = [...j.fixes];
  if (scores.search < 70 && !fixes.some((f) => f.area === "search")) fixes.push({ area: "search", note: stage === "script" ? "Put the search keyword near the start of the title." : "Tune the upload text: keyword early in the title and the first line of the description." });
  if (scores.safety < 80 && !fixes.some((f) => f.area === "safety")) fixes.unshift({ area: "safety", note: "Fix what the kid-safety reviewer flagged first." });
  return { stage, at: Date.now(), scores, ...combineScores(scores), strengths: j.strengths, fixes: fixes.slice(0, 5) };
}
