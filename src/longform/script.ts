import { readFile } from "node:fs/promises";
import { z } from "zod";
import { askAgent } from "../agents";
import type { AiOpts } from "../story/write";
import type { LongClip } from "../../lib/longform";

const strip = (s: Record<string, unknown>) => {
  const { $schema: _d, ...rest } = s;
  return rest;
};
const schemaOf = (t: z.ZodType) => strip(z.toJSONSchema(t, { target: "draft-7" }) as Record<string, unknown>);

const ScriptSchema = z.object({
  title: z.string().describe("YouTube title, under 70 characters. Names the creator and promises the ranking. No hashtags"),
  thumbnailText: z.string().describe("2-4 punchy words for the thumbnail, true of the whole video rather than one moment"),
  intro: z.string().describe("Spoken intro, 35-60 words: why these moments and what makes this ranking worth watching"),
  lines: z.array(z.object({ rank: z.number().int(), line: z.string().describe("Spoken, 15-35 words: your own take on why this moment sits at this rank") })),
  outro: z.string().describe("Spoken outro, 15-30 words: which moment you would change, then ask viewers for their own number one"),
  description: z.string().describe("2-3 sentences for the YouTube description, in the same voice. No hashtags, links or credits"),
  tags: z.array(z.string()).describe("5-12 search tags"),
});
export type LongScript = z.infer<typeof ScriptSchema>;

const ReviewSchema = z.object({
  verdict: z.enum(["ok", "caution"]),
  notes: z.array(z.string()).describe("What to fix, at most 4 short notes; empty when ok"),
});

/** `clips` run from the lowest rank to number one. */
export function scriptPrompt(creator: string, clips: (LongClip & { excerpt: string })[]): string {
  const moments = clips
    .map((c, i) => `#${clips.length - i}: "${c.title}" from "${c.sourceTitle}"\nWhy it stood out: ${c.reason ?? "n/a"}\nWhat is said: ${c.excerpt}`)
    .join("\n\n");
  return `You are the host of a countdown video ranking ${clips.length} moments of ${creator}. The order below is decided. Write the host's words.

${moments}

The host has to add something a viewer can't get from the clips alone, because a pile of clips with no story isn't worth watching and YouTube won't reward it:
- Give a real opinion: compare moments to each other, say why one beats another, and connect them into one thread about ${creator}.
- Never just describe what's about to happen, and don't spoil the punchline.
- Say only what the clips support. Don't invent facts, motives, quotes or background about real people.
- Sound like a person talking: short sentences, no hype words like "insane" or "you won't believe".
- If a moment touches something serious, treat it with care and don't joke about it.
- Never claim to have watched more than these clips, or to have been there.
- Write one line for every rank.`;
}

export async function writeScript(creator: string, clips: (LongClip & { excerpt: string })[], o: AiOpts): Promise<LongScript> {
  const res = await askAgent(o.agent, scriptPrompt(creator, clips), {
    // the same allowance as picking clips: it reads a whole video's worth of transcript
    task: "selection",
    model: o.model,
    maxTurns: 2,
    effort: "medium",
    system: "You write spoken commentary for ranked YouTube countdowns. Answer only with the requested JSON.",
    schema: schemaOf(ScriptSchema),
  });
  const script = ScriptSchema.parse(res.data);
  const missing = clips.map((_, i) => clips.length - i).filter((rank) => !script.lines.some((l) => l.rank === rank && l.line.trim()));
  if (missing.length) throw new Error(`The script has no line for rank ${missing.join(", ")}`);
  return script;
}

const ScreenSchema = z.object({
  avoid: z.array(z.object({ id: z.number().int(), why: z.string() })).describe("The moments to leave out; empty if none"),
});

/**
 * Before a moment goes into a video that ranks it for laughs: leave out what shouldn't be entertainment or would
 * put the video at risk. Returns the positions in `clips` to drop, and why.
 */
export async function screenClips(clips: Pick<LongClip & { excerpt: string }, "title" | "reason" | "excerpt">[], o: AiOpts): Promise<{ index: number; why: string }[]> {
  const list = clips.map((c, i) => `${i}: "${c.title}"\nWhat is said: ${c.excerpt}`).join("\n\n");
  const res = await askAgent(
    o.agent,
    `These moments may go into a ranked comedy countdown on YouTube. Leave one out only if the moment itself centres on: racial slurs or race jokes, self-harm or suicide, sexual content, a possible minor in a sexual or humiliating situation, real violence, humiliating a private person who didn't agree to be on stream, or a real crime played for laughs.

Keep everything else. Swearing, banter, pranks among friends, staged bits people signed up for, gross food, expensive things and a single rude word in passing are all fine. When unsure, keep it: the owner reviews every video.

${list}`,
    { task: "review", model: o.model, maxTurns: 2, effort: "low", system: "You are a careful content reviewer. Answer only with the requested JSON.", schema: schemaOf(ScreenSchema) },
  );
  const seen = new Set<number>();
  return ScreenSchema.parse(res.data).avoid.flatMap((a) => {
    if (a.id < 0 || a.id >= clips.length || seen.has(a.id)) return [];
    seen.add(a.id);
    return [{ index: a.id, why: a.why }];
  });
}

const CoverSchema = z.object({
  best: z.string().describe("The letter of the best frame"),
  usable: z.boolean().describe("False if none of the frames is acceptable"),
  headline: z.string().describe("2-4 punchy words that match what this frame actually shows"),
});

/** Choose the cover among small stills, with words that fit it. Undefined if none will do. */
export async function pickCover(files: string[], title: string): Promise<{ index: number; headline: string } | undefined> {
  const images = await Promise.all(
    files.map(async (f, i) => ({ mediaType: "image/jpeg" as const, label: `Frame ${String.fromCharCode(65 + i)}`, data: (await readFile(f)).toString("base64") })),
  );
  const res = await askAgent(
    "claude",
    `Pick the best YouTube thumbnail frame for "${title}". Want: a person's face, clearly visible, with a strong reaction, sharp and brightly lit. Refuse: dark frames, revealing clothing or a focus on anyone's body, people seen from behind, a violent instant, motion blur, any readable offensive text.`,
    { task: "vision", system: "You pick video thumbnails. Answer only with the requested JSON.", schema: schemaOf(CoverSchema), images, effort: "low", maxTurns: 2, timeoutMs: 120_000 },
  );
  const out = CoverSchema.parse(res.data);
  const i = out.best.trim().toUpperCase().charCodeAt(0) - 65;
  return out.usable && out.headline.trim() && i >= 0 && i < files.length ? { index: i, headline: out.headline.trim() } : undefined;
}

/** A second read: does the host add something of their own, and is anything said about real people unsupported? */
export async function reviewScript(script: LongScript, o: AiOpts) {
  const res = await askAgent(
    o.agent,
    `Review this countdown script for YouTube. "caution" if the host mostly describes the clips rather than adding opinion and comparison, or says anything about a real person that sounds invented or unfair.\n\nIntro: ${script.intro}\n${script.lines.map((l) => `#${l.rank}: ${l.line}`).join("\n")}\nOutro: ${script.outro}`,
    { task: "review", model: o.model, maxTurns: 2, effort: "low", system: "You are a careful editor. Answer only with the requested JSON.", schema: schemaOf(ReviewSchema) },
  );
  return ReviewSchema.parse(res.data);
}
