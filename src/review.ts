import { z } from "zod";
import type { Clip, Word } from "./types";
import { askAgent } from "./agents";
import type { AgentId, Audience, ClipReview, ReviewVerdict } from "../lib/types";

export interface ReviewItem {
  n: number;
  verdict: ReviewVerdict;
  problem?: string;
  title?: string;
  hook?: string;
}

const ReviewSchema = z.object({
  clips: z.array(
    z.object({
      n: z.number(),
      verdict: z.enum(["pass", "fix_hook", "fail"]),
      problem: z.string().optional().describe("One short sentence naming what is wrong (required for fix_hook and fail)"),
      title: z.string().optional().describe("fix_hook only: better title, under 60 chars"),
      hook: z.string().optional().describe("fix_hook only: better on-screen hook, under 40 chars, no emoji"),
    }),
  ),
});

/** A second, independent AI pass over the picks: it did not pick them, so it has nothing to defend. */
export async function reviewPicks(
  words: Word[],
  meta: { title: string; channel?: string },
  clips: (Clip & { n: number })[],
  o: { audience?: Audience; agent: AgentId; model?: string },
): Promise<ReviewItem[]> {
  const blocks = clips.map((c) => {
    const text = words
      .filter((w) => w.start >= c.start - 0.1 && w.start < c.end)
      .map((w) => w.text)
      .join(" ");
    return `#${c.n} (${Math.round(c.end - c.start)}s)\ntitle: ${c.title}\nhook: ${c.hook}\nwhy picked: ${c.reason}\ntranscript: ${text}`;
  });
  const prompt = `Source video: "${meta.title}"${meta.channel ? ` by ${meta.channel}` : ""}

Review these candidate vertical shorts. For each one check:
1. Does it hook in the first 2 seconds?
2. Does it make sense on its own to a viewer with zero context?
3. Does it end on a payoff or a complete thought?
4. Is the hook honest about what actually happens?
${o.audience === "en-us" ? "5. Will an American viewer get it (no unexplained local references)?\n" : ""}
verdict: "pass" if it's good; "fix_hook" if the moment is good but the title/hook is weak or misleading (then write better ones${o.audience === "en-us" ? " in US English" : " in the speakers' language"}); "fail" if the moment itself fails a check. Always give a short "problem" for fix_hook and fail. Be strict but fair: most picks should pass.

${blocks.join("\n\n")}`;
  const { $schema: _d, ...schema } = z.toJSONSchema(ReviewSchema, { target: "draft-7" }) as Record<string, unknown>;
  const res = await askAgent(o.agent, prompt, {
    model: o.model,
    maxTurns: 2,
    effort: "medium",
    system: "You are a strict short-form video editor reviewing someone else's picks. Answer only with the requested JSON.",
    schema,
  });
  const parsed = ReviewSchema.safeParse(res.data);
  if (!parsed.success) throw new Error(`Review output failed validation: ${parsed.error.message}`);
  return parsed.data.clips;
}

/** Apply verdicts: fix_hook rewrites title/hook, fail unticks; then tick the best passing clips up to `count`. */
export function applyReview<T extends { n: number; score: number; title: string; hook: string; selected: boolean; review?: ClipReview }>(
  clips: T[],
  items: ReviewItem[],
  count: number,
): T[] {
  const byN = new Map<number, ReviewItem>();
  for (const it of items) if (!byN.has(it.n)) byN.set(it.n, it);
  const out = clips.map((c) => {
    const it = byN.get(c.n);
    const verdict: ReviewVerdict = it?.verdict ?? "pass";
    const next: T = { ...c, review: { verdict, ...(it?.problem ? { problem: it.problem } : {}) } };
    if (verdict === "fix_hook" && it?.title?.trim() && it?.hook?.trim()) Object.assign(next, { title: it.title.trim(), hook: it.hook.trim() });
    return next;
  });
  const ok = out
    .filter((c) => c.review?.verdict !== "fail")
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((c) => c.n);
  return out.map((c) => ({ ...c, selected: ok.includes(c.n) }));
}
