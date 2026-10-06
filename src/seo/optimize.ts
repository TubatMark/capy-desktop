import { z } from "zod";
import { askAgent } from "../agents";
import type { AgentId, KeywordResearch, SeoReport, SeoText } from "../../lib/types";
import { scoreSeo, type SeoKind } from "./score";

/**
 * The AI half of SEO: pick search phrases to research, then rewrite the upload text around the best keyword.
 * The deterministic score decides: the rewrite is kept only if it scores higher than what was there.
 */

export interface AiOpts {
  agent: AgentId;
  model?: string;
}

const schemaOf = (s: z.ZodType) => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { target: "draft-7" }) as Record<string, unknown>;
  void _drop;
  return rest;
};

const AUDIENCE: Record<SeoKind, string> = {
  short: "a YouTube Short for a US audience",
  video: "a YouTube video for a US audience",
  kids: "a made-for-kids YouTube Short: an animated read-aloud story for young children. Parents search for it and choose it, so write for parents; never address children",
};

const Seeds = z.object({ seeds: z.array(z.string()).describe("2-3 short search phrases (2-5 words) people actually type on YouTube to find this; most likely first") });

/** Search phrases to research for this upload. */
export async function seedPhrases(i: { kind: SeoKind; text: SeoText; about: string }, o: AiOpts): Promise<string[]> {
  const res = await askAgent(
    o.agent,
    `What would someone type into YouTube search to find ${AUDIENCE[i.kind]}?
Title: ${i.text.title}
About: ${i.about.slice(0, 800)}
Give generic searches for the topic (e.g. "bedtime story for toddlers", "funny cat fails"), not the video's own name or character names.`,
    { model: o.model, maxTurns: 2, effort: "low", system: "You are a YouTube SEO researcher. Answer only with the requested JSON.", schema: schemaOf(Seeds), timeoutMs: 90_000 },
  );
  return Seeds.parse(res.data)
    .seeds.map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3)
    .slice(0, 3);
}

const Rewrite = z.object({
  keyword: z.string().describe("The one search phrase this upload should rank for, from the research when it fits"),
  title: z.string().describe("Max 70 characters before any hashtags; the keyword near the start; honest, specific, no all caps"),
  description: z.string().describe("Opens with a sentence containing the keyword; 2-4 short lines on what happens and who it's for; hashtags on the last line"),
  hashtags: z.array(z.string()).describe("3-5 hashtags without #"),
  tags: z.array(z.string()).describe("8-15 search tags: the keyword, close variants and related searches from the research"),
});

export function rewritePrompt(i: { kind: SeoKind; text: SeoText; about: string; research?: KeywordResearch; channelTerms?: string[]; keep?: string }): string {
  const kws = i.research?.keywords.slice(0, 15).map((k) => `- ${k.term} (score ${k.score}; ${k.sources.join(", ")}${k.views ? `; already brought ${k.views} views` : ""})`) ?? [];
  const ranking = i.research?.ranking.slice(0, 6).map((v) => `- "${v.title}"${v.views !== undefined ? ` (${v.views.toLocaleString("en-US")} views)` : ""}`) ?? [];
  return `Tune the upload text of ${AUDIENCE[i.kind]} for YouTube search, without changing what the video is.

Current title: ${i.text.title}
Current description:
${i.text.description}
Current hashtags: ${i.text.hashtags.join(", ") || "(none)"}
Current tags: ${i.text.tags.join(", ") || "(none)"}

What it is: ${i.about.slice(0, 1500)}
${kws.length ? `\nKeywords people search (best first):\n${kws.join("\n")}\n` : ""}${ranking.length ? `\nWhat ranks for "${i.research!.seed}" now:\n${ranking.join("\n")}\n` : ""}${i.research?.tags.length ? `\nTags those videos share: ${i.research.tags.slice(0, 15).join(", ")}\n` : ""}${i.channelTerms?.length ? `\nSearches that already bring this channel viewers: ${i.channelTerms.slice(0, 10).join(", ")}\n` : ""}
Rules:
- Pick the keyword this video can honestly rank for (it must describe the video). Put it near the start of the title and in the first sentence of the description.
- Keep the title true to the video: no promises it doesn't keep, no all caps, at most one emoji.${i.kind === "video" ? "" : "\n- Include #shorts in the hashtags."}${i.kind === "kids" ? "\n- Made for kids: no requests to subscribe, like, comment or turn on notifications; nothing aimed at children. Write for parents." : ""}${i.keep ? `\n- Keep this line in the description: ${i.keep}` : ""}`;
}

/** Put a line (e.g. "Credit: …") back into a description, above its hashtag lines. */
export function withLine(description: string, line: string): string {
  const lines = description.trimEnd().split("\n");
  let at = lines.length;
  while (at > 0 && /^\s*(#\S+\s*)*$/.test(lines[at - 1]!)) at--;
  return [...lines.slice(0, at), line, ...lines.slice(at)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Rewrite for search; keep whichever version scores higher. */
export async function optimizeSeo(
  i: { kind: SeoKind; text: SeoText; about: string; research?: KeywordResearch; channelTerms?: string[]; keep?: string },
  o: AiOpts,
): Promise<{ text: SeoText; report: SeoReport; improved: boolean; rewrite: SeoText; rewriteReport: SeoReport }> {
  const res = await askAgent(o.agent, rewritePrompt(i), {
    model: o.model,
    maxTurns: 2,
    effort: "medium",
    system: "You are a careful YouTube SEO editor. You make videos easy to find without clickbait. Answer only with the requested JSON.",
    schema: schemaOf(Rewrite),
    timeoutMs: 120_000,
  });
  const r = Rewrite.parse(res.data);
  const keyword = r.keyword.trim().toLowerCase();
  const next: SeoText = {
    title: r.title.trim().slice(0, 100),
    description: r.description.trim().slice(0, 5000),
    hashtags: [...new Set(r.hashtags.map((h) => h.replace(/^#/, "").replace(/\s+/g, "").trim()).filter(Boolean))].slice(0, 8),
    tags: [...new Set(r.tags.map((t) => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))].slice(0, 20),
  };
  if (i.keep && !next.description.includes(i.keep)) next.description = withLine(next.description, i.keep);
  const before = scoreSeo(i.text, { keyword, kind: i.kind });
  const after = scoreSeo(next, { keyword, kind: i.kind });
  const improved = after.score > before.score;
  const kept = improved ? after : before;
  return { text: improved ? next : i.text, report: { ...kept, before: before.score, at: Date.now() }, improved, rewrite: next, rewriteReport: { ...after, before: before.score, at: Date.now() } };
}
