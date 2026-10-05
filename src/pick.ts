import { z } from "zod";
import type { Clip, Word } from "./types";
import { snapToWords, transcriptForPrompt } from "./captions";
import { askAgent } from "./agents";
import type { AgentId, Audience } from "../lib/types";
import { fmtPeaks, type HeatPoint } from "./heatmap";

const ClipSchema = z.object({
  start: z.number().describe("Clip start in seconds"),
  end: z.number().describe("Clip end in seconds"),
  reason: z.string().describe("One sentence on why this moment works as a short. Write this first: title and hook must sell exactly this"),
  title: z.string().describe("Short title for the short, under 60 chars. Names what actually happens (the conflict, reveal or payoff from the reason), not a random line"),
  hook: z.string().describe("On-screen hook text shown for the first 2-3s, under 40 chars, no emoji. Frames the situation for a cold viewer, naming the people when known; not a transcript quote"),
  score: z.number().min(1).max(10).describe("Predicted performance, 1-10"),
  ytTitle: z.string().describe("YouTube Shorts title, max 100 chars: punchy, may include one emoji, ends with 2-3 #hashtags"),
  description: z.string().describe("YouTube description, 2-4 short lines: what happens, a question or CTA, then a 'Credit:' line naming the original channel, then the hashtags on the last line"),
  hashtags: z.array(z.string()).min(4).max(8).describe("4-8 hashtags without the # sign: creator names, topic, and always shorts"),
});
const PublishSchema = ClipSchema.pick({ ytTitle: true, description: true, hashtags: true });
const PicksSchema = z.object({ clips: z.array(ClipSchema) });

export interface PickOpts {
  count: number;
  minSec: number;
  maxSec: number;
  /** Which AI to ask (default claude). */
  agent?: AgentId;
  model?: string;
  /** Extra guidance from the user, e.g. "every joke that landed" */
  focus?: string;
  effort?: "low" | "medium" | "high";
  onRetry?: (msg: string) => void;
  /** "Most replayed" ranges to steer the picker toward. */
  peaks?: HeatPoint[];
  /** Who the clips are for; en-us writes all text in US English. */
  audience?: Audience;
  /** Replacing one rejected pick: avoid its problem and every range already taken. */
  replace?: { start: number; end: number; reason: string; avoid: { start: number; end: number }[] };
}

export interface PickResult {
  clips: Clip[];
  raw: unknown;
  costUsd: number;
  durationMs: number;
}

export { askClaude, ClaudeAuthError } from "./agents";

/** Ask the chosen AI (Claude by default) for the best moments; returns clips snapped to word boundaries. */
export async function pickClips(words: Word[], meta: { title: string; duration: number; channel?: string }, o: PickOpts): Promise<PickResult> {
  const t0 = Date.now();
  const res = await askAgent(o.agent ?? "claude", buildPrompt(transcriptForPrompt(words), meta, o), {
    model: o.model,
    maxTurns: 3,
    effort: o.effort ?? "medium",
    system:
      "You are a senior short-form video editor. You find the moments in long videos that perform best as vertical shorts. You only answer with the requested JSON.",
    schema: picksJsonSchema(),
    onRetry: o.onRetry,
  });

  const raw = res.data;
  if (!raw) throw new Error("The AI returned no structured output");
  const parsed = PicksSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`AI output failed validation: ${parsed.error.message}`);

  return {
    clips: postProcess(parsed.data.clips, words, meta.duration, o),
    raw,
    costUsd: res.costUsd,
    durationMs: Date.now() - t0,
  };
}

/** JSON Schema for the picks, without the $schema tag (Claude Code's validator rejects draft 2020-12 refs). */
export function picksJsonSchema(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(PicksSchema, { target: "draft-7" }) as Record<string, unknown>;
  return schema;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** What language the title/hook/upload text is written in. */
export function languageRule(audience?: Audience): string {
  return audience === "en-us"
    ? "Write title, hook, ytTitle, description and hashtags in natural US English for American viewers, even when the speakers use another language. Avoid moments that only work with local cultural context the hook can't explain. Prefer hashtags US viewers search for."
    : "title and hook in the same language the speakers use.";
}

export function buildPrompt(transcript: string, meta: { title: string; duration: number; channel?: string }, o: PickOpts): string {
  const mins = Math.round(meta.duration / 60);
  return `Video: "${meta.title}" (${mins} min)${meta.channel ? ` by ${meta.channel}` : ""}

Pick the ${o.count} best moments to publish as standalone vertical shorts (TikTok / Reels / YouTube Shorts).

Rules:
- Each clip must be ${o.minSec}-${o.maxSec} seconds long and self-contained: a viewer with zero context must get it.
- Start on a strong hook line, ideally a claim, question, contrarian take, punchline setup, or emotional peak. Never start mid-sentence.
- End on a complete thought or payoff. Never end mid-sentence.
- Prefer moments with: a clear single idea, concrete specifics, story beats, humor that landed, or strong emotion.
- Avoid: intros, sponsor reads, housekeeping, "as I said earlier", references to things not in the clip, dead air.
- Clips must not overlap. Spread across the video when quality allows.
- Decide the reason first, then write title and hook that sell that exact moment. If the reason is "a heated argument over a missed trip", the title and hook are about that argument, not a throwaway line from it.
- hook = the text a viewer with zero context reads before anyone speaks. Set up the situation or stakes in third person and name who is in it when the video title or channel tells you (e.g. "Mia & Jay almost fall out over a missed trip"). Do not just quote the transcript; a quote only works if it makes sense on its own and states the conflict.
- title = what happens in the clip (the conflict, reveal, or payoff), specific, under 60 chars.
- ${languageRule(o.audience)}
- For each clip also write the YouTube Shorts upload text: ytTitle (max 100 chars, may include one emoji, end with 2-3 #hashtags like "#${(meta.channel ?? "creator").replace(/[^a-z0-9]/gi, "").toLowerCase()} #shorts"), a description (2-4 short lines: what happens, a hook question or CTA, "Credit: ${meta.channel ?? "original creator"}", hashtags last), and 4-8 hashtags (no # sign; include creator names, the topic, and shorts).
- start and end are in seconds from the start of the video. Each transcript line starts at the [seconds] marker; estimate positions within a line proportionally.
${o.replace ? `- Find a different moment. The previous pick at ${mmss(o.replace.start)}–${mmss(o.replace.end)} was rejected because: ${o.replace.reason}. Avoid that problem. Do not overlap these ranges: ${[o.replace, ...o.replace.avoid].map((r) => `${mmss(r.start)}–${mmss(r.end)}`).join(", ")}.\n` : ""}${o.focus ? `- Editor's focus: ${o.focus}\n` : ""}
${o.peaks?.length ? `Viewer replay peaks (the parts viewers rewound to most: a strong signal of a great moment; prefer clips that contain one, but each clip must still be self-contained):\n${fmtPeaks(o.peaks)}\n\n` : ""}Transcript:
${transcript}`;
}

const TitleHookSchema = ClipSchema.pick({ title: true, hook: true });

/** Rewrite one clip's title and hook so they match why it was picked (for picks with a weak or quote-y hook). */
export async function rewriteTitleHook(
  words: Word[],
  meta: { title: string; channel?: string },
  clip: { start: number; end: number; title: string; hook: string; reason: string },
  model?: string,
  agent: AgentId = "claude",
  audience?: Audience,
): Promise<{ title: string; hook: string }> {
  const excerpt = words
    .filter((w) => w.start >= clip.start - 0.1 && w.start < clip.end)
    .map((w) => w.text)
    .join(" ");
  const prompt = `Source video: "${meta.title}"${meta.channel ? ` by ${meta.channel}` : ""}
Why this clip was picked: ${clip.reason}
Current title: ${clip.title}
Current hook: ${clip.hook}
Transcript of the clip:
${excerpt}

Write a better title and on-screen hook for this vertical short:
- Both must sell the moment described in "why this clip was picked", not a throwaway line from the transcript.
- hook: under 40 chars, no emoji. The text a viewer with zero context reads before anyone speaks: set up the situation or stakes in third person and name who is in it when the video title or channel tells you (e.g. "Mia & Jay almost fall out over a missed trip"). Only quote the transcript if the quote alone states the conflict.
- title: under 60 chars, says what happens (the conflict, reveal, or payoff), specific.
${audience === "en-us" ? "Write in natural US English for American viewers." : "Same language as the speakers."}`;
  const { data: raw } = await askAgent(agent, prompt, {
    model,
    maxTurns: 2,
    effort: "low",
    system: "You are a senior short-form video editor who writes hooks that stop the scroll without lying about the content. Answer only with the requested JSON.",
    schema: stripSchema(z.toJSONSchema(TitleHookSchema, { target: "draft-7" }) as Record<string, unknown>),
  });
  const parsed = TitleHookSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`AI output failed validation: ${parsed.error.message}`);
  return parsed.data;
}

/** Publish metadata for one clip (used to fill in older picks, or to regenerate). */
export async function generatePublish(
  words: Word[],
  meta: { title: string; channel?: string },
  clip: { start: number; end: number; title: string; hook: string },
  model?: string,
  agent: AgentId = "claude",
  audience?: Audience,
): Promise<{ ytTitle: string; description: string; hashtags: string[] }> {
  const excerpt = words
    .filter((w) => w.start >= clip.start - 0.1 && w.start < clip.end)
    .map((w) => w.text)
    .join(" ");
  const handle = (meta.channel ?? "creator").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const prompt = `Source video: "${meta.title}"${meta.channel ? ` by ${meta.channel}` : ""}
Clip title: ${clip.title}
Hook: ${clip.hook}
Transcript of the clip:
${excerpt}

Write the YouTube Shorts upload text for this clip:
- ytTitle: max 100 chars, punchy, may include one emoji, ends with 2-3 #hashtags (e.g. "#${handle} #shorts").
- description: 2-4 short lines: what happens, a hook question or CTA, then "Credit: ${meta.channel ?? "original creator"}", then the hashtags on the last line.
- hashtags: 4-8 without the # sign: creator names, topic, and shorts.
${audience === "en-us" ? "Write in natural US English for American viewers." : "Same language as the speakers."}`;
  const { data: raw } = await askAgent(agent, prompt, {
    model,
    maxTurns: 2,
    effort: "low",
    system: "You write YouTube Shorts titles and descriptions that get clicks without lying about the content. Answer only with the requested JSON.",
    schema: stripSchema(z.toJSONSchema(PublishSchema, { target: "draft-7" }) as Record<string, unknown>),
  });
  const parsed = PublishSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`AI output failed validation: ${parsed.error.message}`);
  return parsed.data;
}

function stripSchema(s: Record<string, unknown>) {
  const { $schema: _d, ...rest } = s;
  return rest;
}

/** Snap to word/sentence boundaries, clamp to maxSec on a word end, drop too-short clips and real overlaps. */
export function postProcess(
  clips: z.infer<typeof ClipSchema>[],
  words: Word[],
  duration: number,
  o: Pick<PickOpts, "minSec" | "maxSec">,
): Clip[] {
  const minKeep = Math.max(8, o.minSec * 0.6);
  const out: Clip[] = [];
  for (const c of clips) {
    if (!(c.end > c.start)) continue;
    let { start, end } = snapToWords(words, c.start, c.end);
    start = Math.max(0, start);
    end = Math.min(duration || end, end);
    if (end - start > o.maxSec) {
      // cut at the last word that finishes inside the limit (never mid-word)
      const limit = start + o.maxSec - 0.25;
      let lastEnd = -1;
      for (const w of words) {
        if (w.start < start) continue;
        if (w.end > limit) break;
        lastEnd = w.end;
      }
      end = lastEnd > start ? lastEnd + 0.25 : start + o.maxSec;
    }
    if (end - start < minKeep) continue;
    out.push({ ...c, start, end });
  }
  // drop real overlaps (>1s), keeping the higher score; back-to-back clips are fine
  out.sort((a, b) => b.score - a.score);
  const kept: Clip[] = [];
  for (const c of out) {
    if (kept.some((k) => c.start < k.end - 1 && c.end > k.start + 1)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.start - b.start);
}
