import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FrameCandidate, ThumbnailLayout } from "../lib/thumbnails";
import type { AiImage } from "./ai-router";
import { run } from "../src/exec";

/** How the automatic designs were chosen: the AI looked at real frames, or the local sharpness ranking ran. */
export interface ThumbnailPick {
  /** Best first; every frame is one of the extracted candidates. */
  frames: FrameCandidate[];
  headline: string;
  layout?: ThumbnailLayout;
  by: "ai" | "heuristic";
  reason?: string;
}
export interface ThumbnailPickInput {
  frames: FrameCandidate[];
  title?: string;
  hook?: string;
  transcript?: string;
  /** Used whenever the AI is unavailable or its headline cannot be trusted. */
  fallbackHeadline: string;
  /** Scratch folder for the downscaled copies sent to the AI. */
  directory: string;
}
/** A structured vision question; production routes it through askAgent (task "vision", budgeted, cached). */
export type VisionAsk = (
  prompt: string,
  o: {
    system: string;
    schema: Record<string, unknown>;
    images: AiImage[];
    validate: (data: unknown) => boolean;
  },
) => Promise<{ data: unknown }>;

export const PICK_FRAME_LIMIT = 8;
const LAYOUTS: ThumbnailLayout[] = ["bold", "editorial", "minimal"];
const LABELS = "ABCDEFGH".split("");
const MAX_HEADLINE_WORDS = 6;

const askClaude: VisionAsk = async (prompt, o) => {
  const { askAgent } = await import("../src/agents");
  return askAgent("claude", prompt, {
    task: "vision",
    system: o.system,
    schema: o.schema,
    images: o.images,
    validate: o.validate,
    effort: "low",
    maxTurns: 2,
    timeoutMs: 120_000,
  });
};

const clean = (text: string) =>
  text
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/** The existing behaviour: sharpness × exposure order and the clip's own hook. */
export function heuristicPick(
  frames: FrameCandidate[],
  fallbackHeadline: string,
  reason?: string,
): ThumbnailPick {
  return {
    frames: [...frames].sort((a, b) => b.quality.score - a.quality.score),
    headline: clean(fallbackHeadline).slice(0, 120),
    by: "heuristic",
    ...(reason ? { reason } : {}),
  };
}
/** Numbers are the easiest claim to invent: every one in the headline must appear in what the clip says. */
export function headlineIsGrounded(headline: string, context: string) {
  const said = context.toLowerCase().replace(/,/g, "");
  return (headline.toLowerCase().replace(/,/g, "").match(/\d+(\.\d+)?/g) ?? [])
    .every((n) => said.includes(n));
}
async function downscale(frame: FrameCandidate, directory: string) {
  const out = path.join(directory, `${frame.id}.jpg`);
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      frame.path,
      "-vf",
      "scale=w=512:h=512:force_original_aspect_ratio=decrease",
      "-q:v",
      "6",
      "-frames:v",
      "1",
      "-y",
      out,
    ],
    { timeoutMs: 30_000 },
  );
  return (await readFile(out)).toString("base64");
}
/**
 * Ask the AI to rank real frames and write a short, truthful headline. Never throws: any failure (no login,
 * budget used up, bad answer) falls back to the local ranking and the clip's hook, so the clip is never held up.
 */
export async function pickThumbnail(
  input: ThumbnailPickInput,
  ask: VisionAsk = askClaude,
): Promise<ThumbnailPick> {
  const ranked = heuristicPick(input.frames, input.fallbackHeadline);
  const candidates = ranked.frames.slice(0, PICK_FRAME_LIMIT);
  if (!candidates.length) return ranked;
  try {
    await mkdir(input.directory, { recursive: true });
    const labels = LABELS.slice(0, candidates.length);
    const images: AiImage[] = [];
    for (const [i, frame] of candidates.entries())
      images.push({
        mediaType: "image/jpeg",
        label: `Frame ${labels[i]}`,
        data: await downscale(frame, input.directory),
      });
    const title = clean(input.title ?? "").slice(0, 300),
      hook = clean(input.hook ?? "").slice(0, 300),
      transcript = clean(input.transcript ?? "").slice(0, 2500);
    const schema = {
      type: "object",
      properties: {
        ranking: {
          type: "array",
          items: { type: "string", enum: labels },
          minItems: 1,
          maxItems: labels.length,
        },
        headline: { type: "string", minLength: 1, maxLength: 48 },
        layout: { type: "string", enum: LAYOUTS },
        reason: { type: "string", maxLength: 240 },
      },
      required: ["ranking", "headline", "layout"],
      additionalProperties: false,
    };
    const prompt = [
      "Choose the best YouTube thumbnail frame for this short video clip and write its headline.",
      title && `Clip title: ${title}`,
      hook && `Hook: ${hook}`,
      transcript && `What is said in the clip:\n"""${transcript}"""`,
      `The ${labels.length} frames below (${labels.join(", ")}) are real stills from the clip.`,
      "ranking: frame letters from best to worst thumbnail, at least the best three. Prefer sharp, well-lit frames with an expressive face or a clear main subject at the moment the clip is about. Avoid blur, closed eyes, black or transition frames, scoreboards, menus or other on-screen interface, and frames covered by burned-in captions or text.",
      `headline: at most 5 words, true to what is said in the clip. Do not invent facts, numbers, names or outcomes that are not in the title, hook or transcript. No misleading clickbait, no emoji, no hashtags, no quotes.`,
      'layout: "bold" (big colour block, punchy), "editorial" (calm split panel) or "minimal" (lots of empty space), whichever suits the best frame and topic.',
      "reason: one short sentence on why the best frame works.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const { data } = await ask(prompt, {
      system:
        "You pick thumbnail frames from real video stills and write short, honest headlines. Answer only with JSON that matches the schema.",
      schema,
      images,
      validate: (value) => {
        const v = value as { ranking?: unknown[] };
        return (
          Array.isArray(v?.ranking) &&
          new Set(v.ranking).size === v.ranking.length
        );
      },
    });
    const answer = data as {
      ranking: string[];
      headline: string;
      layout: ThumbnailLayout;
      reason?: string;
    };
    const chosen = answer.ranking.map((l) => candidates[labels.indexOf(l)]!);
    const frames = [
      ...chosen,
      ...ranked.frames.filter((f) => !chosen.includes(f)),
    ];
    const headline = clean(answer.headline).replace(/^["'“”]+|["'“”]+$/g, "");
    const trusted =
      headline &&
      headline.split(" ").length <= MAX_HEADLINE_WORDS &&
      headlineIsGrounded(headline, `${title} ${hook} ${transcript}`);
    return {
      frames,
      headline: trusted ? headline : ranked.headline,
      layout: LAYOUTS.includes(answer.layout) ? answer.layout : undefined,
      by: "ai",
      reason: trusted
        ? answer.reason && clean(answer.reason).slice(0, 240)
        : "The AI headline was not supported by the clip, so the clip's hook is used",
    };
  } catch (error) {
    return heuristicPick(
      input.frames,
      input.fallbackHeadline,
      `AI pick unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        240,
      ),
    );
  }
}
