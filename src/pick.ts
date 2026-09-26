import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Clip, Word } from "./types";
import { snapToWords, transcriptForPrompt } from "./captions";

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
  model?: string;
  /** Extra guidance from the user, e.g. "every joke that landed" */
  focus?: string;
  effort?: "low" | "medium" | "high";
  onRetry?: (msg: string) => void;
}

export interface PickResult {
  clips: Clip[];
  raw: unknown;
  costUsd: number;
  durationMs: number;
}

export class ClaudeAuthError extends Error {}

/**
 * One-shot Claude call through the Agent SDK (billed to the `claude` login on this machine).
 * Fails fast on auth errors instead of silently retrying for minutes, and drops
 * ANTHROPIC_API_KEY from the subprocess so usage goes to the Claude plan
 * (set CAPY_USE_API_KEY=1 to keep it).
 */
export async function askClaude(
  prompt: string,
  options: Options,
  o: { timeoutMs?: number; onRetry?: (msg: string) => void } = {},
): Promise<any> {
  const abortController = new AbortController();
  const env: Record<string, string | undefined> = { ...process.env };
  if (!(process.env.CAPY_USE_API_KEY ?? process.env.CLIPRUN_USE_API_KEY)) delete env.ANTHROPIC_API_KEY;
  let timedOut = false;
  const timer = o.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, o.timeoutMs)
    : undefined;

  let result: any;
  try {
    for await (const m of query({ prompt, options: { ...options, env, abortController } })) {
      if (m.type === "system" && (m as any).subtype === "api_retry") {
        const r = m as any;
        if (r.error_status === 401 || r.error_status === 403) {
          abortController.abort();
          throw new ClaudeAuthError("Claude login missing or expired. Run `claude`, log in, then try again.");
        }
        o.onRetry?.(`Claude API retry ${r.attempt}/${r.max_retries} (${r.error_status ?? "network error"})`);
      }
      if (m.type === "result") result = m;
    }
  } catch (e) {
    if (e instanceof ClaudeAuthError) throw e;
    if (timedOut) throw new Error(`Claude did not answer within ${Math.round(o.timeoutMs! / 1000)}s`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!result) throw new Error(timedOut ? "Claude timed out" : "Claude returned no result");
  if (result.is_error) {
    const text = String(result.result ?? result.subtype);
    if (/log ?in|auth/i.test(text)) throw new ClaudeAuthError(`${text}. Run \`claude\` and log in.`);
    throw new Error(`Claude returned an error: ${text}`);
  }
  return result;
}

/** Ask Claude to choose the best moments; returns clips snapped to word boundaries. */
export async function pickClips(words: Word[], meta: { title: string; duration: number; channel?: string }, o: PickOpts): Promise<PickResult> {
  const t0 = Date.now();
  const result = await askClaude(
    buildPrompt(transcriptForPrompt(words), meta, o),
    {
      model: o.model,
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 3,
      effort: o.effort ?? "medium",
      systemPrompt:
        "You are a senior short-form video editor. You find the moments in long videos that perform best as vertical shorts. You only answer with the requested JSON.",
      outputFormat: { type: "json_schema", schema: picksJsonSchema() },
    },
    { onRetry: o.onRetry },
  );

  const raw = result.structured_output ?? tryParse(result.result);
  if (!raw) throw new Error("Claude returned no structured output");
  const parsed = PicksSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Claude output failed validation: ${parsed.error.message}`);

  return {
    clips: postProcess(parsed.data.clips, words, meta.duration, o),
    raw,
    costUsd: result.total_cost_usd ?? 0,
    durationMs: Date.now() - t0,
  };
}

/** JSON Schema for the picks, without the $schema tag (Claude Code's validator rejects draft 2020-12 refs). */
export function picksJsonSchema(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(PicksSchema, { target: "draft-7" }) as Record<string, unknown>;
  return schema;
}

function tryParse(s: unknown): unknown {
  if (typeof s !== "string") return undefined;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
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
- title and hook in the same language the speakers use.
- For each clip also write the YouTube Shorts upload text: ytTitle (max 100 chars, may include one emoji, end with 2-3 #hashtags like "#${(meta.channel ?? "creator").replace(/[^a-z0-9]/gi, "").toLowerCase()} #shorts"), a description (2-4 short lines: what happens, a hook question or CTA, "Credit: ${meta.channel ?? "original creator"}", hashtags last), and 4-8 hashtags (no # sign; include creator names, the topic, and shorts).
- start and end are in seconds from the start of the video. Each transcript line starts at the [seconds] marker; estimate positions within a line proportionally.
${o.focus ? `- Editor's focus: ${o.focus}\n` : ""}
Transcript:
${transcript}`;
}

const TitleHookSchema = ClipSchema.pick({ title: true, hook: true });

/** Rewrite one clip's title and hook so they match why it was picked (for picks with a weak or quote-y hook). */
export async function rewriteTitleHook(
  words: Word[],
  meta: { title: string; channel?: string },
  clip: { start: number; end: number; title: string; hook: string; reason: string },
  model?: string,
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
Same language as the speakers.`;
  const r = await askClaude(prompt, {
    model,
    tools: [],
    settingSources: [],
    persistSession: false,
    maxTurns: 2,
    effort: "low",
    systemPrompt: "You are a senior short-form video editor who writes hooks that stop the scroll without lying about the content. Answer only with the requested JSON.",
    outputFormat: { type: "json_schema", schema: stripSchema(z.toJSONSchema(TitleHookSchema, { target: "draft-7" }) as Record<string, unknown>) },
  });
  const raw = r.structured_output ?? tryParse(r.result);
  const parsed = TitleHookSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Claude output failed validation: ${parsed.error.message}`);
  return parsed.data;
}

/** Publish metadata for one clip (used to fill in older picks, or to regenerate). */
export async function generatePublish(
  words: Word[],
  meta: { title: string; channel?: string },
  clip: { start: number; end: number; title: string; hook: string },
  model?: string,
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
Same language as the speakers.`;
  const r = await askClaude(prompt, {
    model,
    tools: [],
    settingSources: [],
    persistSession: false,
    maxTurns: 2,
    effort: "low",
    systemPrompt: "You write YouTube Shorts titles and descriptions that get clicks without lying about the content. Answer only with the requested JSON.",
    outputFormat: { type: "json_schema", schema: stripSchema(z.toJSONSchema(PublishSchema, { target: "draft-7" }) as Record<string, unknown>) },
  });
  const raw = r.structured_output ?? tryParse(r.result);
  const parsed = PublishSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Claude output failed validation: ${parsed.error.message}`);
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
