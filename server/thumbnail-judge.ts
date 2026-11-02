import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ThumbnailDesign } from "../lib/thumbnails";
import type { AiImage } from "./ai-router";
import { askClaude, type VisionAsk } from "./thumbnail-pick";
import { run } from "../src/exec";

/** The thumbnail reviewer's answer: designs best first, and why the first wins. */
export interface ThumbnailJudgment {
  order: string[];
  by: "ai" | "default";
  reason?: string;
}
export interface ThumbnailJudgeInput {
  designs: ThumbnailDesign[];
  title?: string;
  hook?: string;
  /** Scratch folder for the feed-sized copies sent to the AI. */
  directory: string;
}

const LABELS = "ABCDEF".split("");
const clean = (text: string) =>
  text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();

const jpgOf = (d: ThumbnailDesign) => d.versions.filter((v) => v.format === "jpg").at(-1);

/** About the size a Short's thumbnail shows in the feed and channel grid: legibility is judged there. */
async function feedSize(file: string, directory: string, id: string, width = 270) {
  const out = path.join(directory, `judge-${width}-${id}.jpg`);
  await run(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", `scale=w=${width}:h=${Math.round((width * 16) / 9)}:force_original_aspect_ratio=decrease`, "-q:v", "5", "-frames:v", "1", "-y", out],
    { timeoutMs: 30_000 },
  );
  return (await readFile(out)).toString("base64");
}

/**
 * Ask the AI which finished design would earn the most clicks, judged the way a viewer meets it: small, in a feed.
 * Never throws; without an answer the designs keep their order (the source thumbnail first, then the AI-picked
 * frame designs).
 */
export async function judgeThumbnails(
  input: ThumbnailJudgeInput,
  ask: VisionAsk = askClaude,
): Promise<ThumbnailJudgment> {
  const designs = input.designs.filter((d) => jpgOf(d)).slice(0, LABELS.length);
  const fallback = (reason?: string): ThumbnailJudgment => ({
    order: input.designs.map((d) => d.id),
    by: "default",
    ...(reason ? { reason } : {}),
  });
  if (designs.length < 2) return fallback();
  try {
    await mkdir(input.directory, { recursive: true });
    const labels = LABELS.slice(0, designs.length);
    const images: AiImage[] = [];
    for (const [i, d] of designs.entries())
      images.push({
        mediaType: "image/jpeg",
        label: `Design ${labels[i]}`,
        data: await feedSize(jpgOf(d)!.path, input.directory, d.id),
      });
    const title = clean(input.title ?? "").slice(0, 300),
      hook = clean(input.hook ?? "").slice(0, 300);
    const schema = {
      type: "object",
      properties: {
        ranking: { type: "array", items: { type: "string", enum: labels }, minItems: labels.length, maxItems: labels.length },
        reason: { type: "string", maxLength: 200 },
      },
      required: ["ranking", "reason"],
      additionalProperties: false,
    };
    const prompt = [
      "You review thumbnails for a YouTube Short before it is posted. Rank these finished designs by how many viewers would tap it in the Shorts feed and on the channel page.",
      title && `Video title: ${title}`,
      hook && `Hook: ${hook}`,
      `The ${labels.length} designs (${labels.join(", ")}) are shown at about the size viewers see them.`,
      "Judge: the subject reads instantly at this small size (a clear face, emotion or object); the headline is legible; strong contrast and a clean composition; it promises what the title is about without misleading; it stands out from a feed of similar videos. Penalize clutter, tiny or cut-off text, dark or muddy images, and scoreboards or interface screenshots as the main subject.",
      "ranking: every design letter, most effective first. reason: one short sentence on why the first wins, in plain words for the channel owner.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const { data } = await ask(prompt, {
      system: "You judge thumbnail effectiveness from the images shown. Answer only with JSON that matches the schema.",
      schema,
      images,
      validate: (value) => {
        const v = value as { ranking?: unknown[] };
        return Array.isArray(v?.ranking) && new Set(v.ranking).size === labels.length && v.ranking.every((l) => labels.includes(l as string));
      },
    });
    const answer = data as { ranking: string[]; reason: string };
    const ranked = answer.ranking.map((l) => designs[labels.indexOf(l)]!.id);
    return {
      order: [...ranked, ...input.designs.map((d) => d.id).filter((id) => !ranked.includes(id))],
      by: "ai",
      reason: clean(answer.reason).slice(0, 200),
    };
  } catch (error) {
    return fallback(`Thumbnail review unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
  }
}

export interface ThumbnailVerdict {
  ok: boolean;
  /** Must never go public, whatever else is available. */
  severe: boolean;
  problems?: string;
}
export interface ThumbnailReview {
  by: "ai" | "default";
  of: Record<string, ThumbnailVerdict>;
  reason?: string;
}

/**
 * The last check before a design goes public. The ranking above only compares designs, so the best of a bad set still
 * won; this can say no. Never throws: without an answer the ranking stands and the clip isn't held up.
 */
export async function reviewThumbnails(input: ThumbnailJudgeInput, ask: VisionAsk = askClaude): Promise<ThumbnailReview> {
  const designs = input.designs.filter((d) => jpgOf(d)).slice(0, LABELS.length);
  if (!designs.length) return { by: "default", of: {} };
  try {
    await mkdir(input.directory, { recursive: true });
    const labels = LABELS.slice(0, designs.length);
    const images: AiImage[] = [];
    for (const [i, d] of designs.entries())
      images.push({
        mediaType: "image/jpeg",
        label: `Design ${labels[i]}`,
        // large enough to read every word on it: a slur has to be caught even if it's small
        data: await feedSize(jpgOf(d)!.path, input.directory, d.id, 540),
      });
    const title = clean(input.title ?? "").slice(0, 300),
      hook = clean(input.hook ?? "").slice(0, 300);
    const schema = {
      type: "object",
      properties: {
        designs: {
          type: "array",
          minItems: labels.length,
          maxItems: labels.length,
          items: {
            type: "object",
            properties: {
              design: { type: "string", enum: labels },
              ok: { type: "boolean" },
              severe: { type: "boolean" },
              problems: { type: "string", maxLength: 200 },
            },
            required: ["design", "ok", "severe"],
            additionalProperties: false,
          },
        },
      },
      required: ["designs"],
      additionalProperties: false,
    };
    const prompt = [
      "You are the last check on these YouTube Short thumbnails before they go public. Check each design on its own.",
      title && `Video title: ${title}`,
      hook && `Hook: ${hook}`,
      `The ${labels.length} designs (${labels.join(", ")}) follow.`,
      "ok is false when any of these is true: a video caption or half a sentence is burned into the picture; video player controls, a browser bar or social media interface show in the picture; the picture is blurred, mostly dark or has no clear subject; the headline is cut off, hard to read or doesn't fit the title. Otherwise ok is true.",
      "severe is true only for: a readable slur or hateful word, explicit sexual words or imagery, graphic injury, or a headline that states something false. Lines of stream chat too small to read at phone size don't count. Everything else is not severe.",
      "problems: when ok is false, one short sentence in plain words for the channel owner. Leave it out otherwise.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const { data } = await ask(prompt, {
      system: "You review finished thumbnails from the images shown. Answer only with JSON that matches the schema.",
      schema,
      images,
      validate: (value) => {
        const v = value as { designs?: { design?: string }[] };
        return Array.isArray(v?.designs) && labels.every((l) => v.designs!.some((d) => d.design === l));
      },
    });
    const answer = data as { designs: { design: string; ok: boolean; severe: boolean; problems?: string }[] };
    const of: Record<string, ThumbnailVerdict> = {};
    for (const a of answer.designs) {
      const d = designs[labels.indexOf(a.design)];
      if (d) of[d.id] = { ok: a.ok && !a.severe, severe: a.severe, ...(a.problems ? { problems: clean(a.problems).slice(0, 200) } : {}) };
    }
    if (!Object.keys(of).length) throw Error("The answer named no designs");
    return { by: "ai", of };
  } catch (error) {
    return { by: "default", of: {}, reason: `Thumbnail review unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
  }
}

/** Keeps the ranking within each group: designs that pass, then weak ones, then those that must not be posted. */
export function orderByReview<T extends { id: string }>(designs: T[], review: ThumbnailReview): T[] {
  const group = (d: T) => (review.of[d.id]?.severe ? 2 : review.of[d.id]?.ok === false ? 1 : 0);
  return [...designs].sort((a, b) => group(a) - group(b));
}
