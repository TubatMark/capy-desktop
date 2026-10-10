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
async function feedSize(file: string, directory: string, id: string) {
  const out = path.join(directory, `judge-${id}.jpg`);
  await run(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", "scale=w=270:h=480:force_original_aspect_ratio=decrease", "-q:v", "5", "-frames:v", "1", "-y", out],
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
