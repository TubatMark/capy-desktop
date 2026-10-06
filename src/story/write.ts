import { z } from "zod";
import { askAgent } from "../agents";
import type { AgentId, StoryPage, StoryReview, StorySeries, StoryState } from "../../lib/types";
import { sanitizeSvg } from "./svg";

/**
 * The words and pictures of a story, by AI: the writer, the kid-safety reviewer, revisions, the character sprites,
 * each page's scene, and the upload text (written for parents). All return plain data; nothing here touches disk.
 */

export interface AiOpts {
  agent: AgentId;
  model?: string;
}

const strip = (s: Record<string, unknown>) => {
  const { $schema: _d, ...rest } = s;
  return rest;
};
const schemaOf = (t: z.ZodType) => strip(z.toJSONSchema(t, { target: "draft-7" }) as Record<string, unknown>);

const AGE_RULES: Record<StorySeries["ageBand"], string> = {
  "2-4": "Ages 2-4: 6-8 pages; at most 15 words a page; very simple words; short sentences; a little repetition or a refrain; one tiny problem, solved warmly.",
  "5-8": "Ages 5-8: 8-10 pages; at most 30 words a page; simple vivid words; a small problem the characters solve themselves; gentle humour.",
};

const castLine = (s: StorySeries) => s.characters.map((c) => `- ${c.name} (id: ${c.id}): ${c.description}`).join("\n");

// ---------- writer ----------

const StorySchema = z.object({
  title: z.string().describe("Short, warm title, Title Case"),
  moral: z.string().describe("The one gentle idea the story leaves (for parents, not read aloud)"),
  pages: z.array(
    z.object({
      text: z.string().describe("The words read aloud on this page"),
      scene: z.string().describe("What the picture shows: place, time of day, props. No characters' actions beyond where they are"),
      cast: z.array(z.object({ id: z.string(), x: z.number().describe("0..1 across the page"), flip: z.boolean().optional().describe("true = faces left") })),
      mood: z.string().optional(),
    }),
  ),
});

export function storyWriterPrompt(series: StorySeries, brief: string): string {
  return `Write an original picture-book story for the series "${series.title}".

Characters (use only these, by id):
${castLine(series)}

Tone: ${series.tone}
Values the series cares about: ${series.values.join(", ") || "kindness"}
${AGE_RULES[series.ageBand]}

Story idea: ${brief}

Rules:
- Original story, not a retelling of any existing book, film or show. No brand names or real people.
- Nothing scary, violent or unsafe that a child could copy (no climbing high places alone, no talking to strangers, no playing with fire or water unsupervised). Calm, happy ending.
- Every page: the words to read aloud, the scene for the illustration, and which characters are in it (cast ids with a position x from 0 to 1; at most 3 per page).
- Speak to children warmly; never mention being an AI or the app.`;
}

const spread = (k: number, n: number) => Math.round(((k + 1) / (n + 1)) * 100) / 100;

/** Clean the writer's answer: real cast only (max 3 a page), positions filled in, 1-12 non-empty pages. */
export function normalizeStory(raw: unknown, series: StorySeries): { title: string; moral: string; pages: StoryPage[] } {
  type Loose = { title?: unknown; moral?: unknown; pages?: { text?: unknown; scene?: unknown; mood?: unknown; cast?: { id?: unknown; x?: unknown; flip?: unknown }[] }[] };
  const r = (raw ?? {}) as Loose;
  const ids = new Set(series.characters.map((c) => c.id));
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const pages: StoryPage[] = (Array.isArray(r.pages) ? r.pages : [])
    .filter((p) => str(p?.text))
    .slice(0, 12)
    .map((p) => {
      const cast = (Array.isArray(p.cast) ? p.cast : []).filter((c) => typeof c?.id === "string" && ids.has(c.id)).slice(0, 3);
      return {
        text: str(p.text),
        scene: str(p.scene),
        ...(str(p.mood) ? { mood: str(p.mood) } : {}),
        cast: cast.map((c, k) => ({ id: c.id as string, x: typeof c.x === "number" && c.x >= 0 && c.x <= 1 ? c.x : spread(k, cast.length), ...(c.flip === true ? { flip: true } : {}) })),
        status: "pending" as const,
      };
    });
  if (!pages.length) throw new Error("The AI wrote no pages. Try a different story idea.");
  return { title: str(r.title) || "Untitled", moral: str(r.moral), pages };
}

export async function writeStory(series: StorySeries, brief: string, o: AiOpts) {
  const res = await askAgent(o.agent, storyWriterPrompt(series, brief), {
    model: o.model,
    maxTurns: 2,
    effort: "medium",
    system: "You write original, gentle picture-book stories for young children. Answer only with the requested JSON.",
    schema: schemaOf(StorySchema),
  });
  return normalizeStory(res.data, series);
}

export async function reviseStory(series: StorySeries, story: Pick<StoryState, "title" | "moral" | "pages">, notes: string[], o: AiOpts) {
  const current = JSON.stringify({ title: story.title, moral: story.moral, pages: story.pages.map((p) => ({ text: p.text, scene: p.scene, cast: p.cast, mood: p.mood })) });
  const res = await askAgent(
    o.agent,
    `${storyWriterPrompt(series, "(revise the story below)")}

Current story:
${current}

Revise it to fix these notes, keeping everything else:
${notes.map((n) => `- ${n}`).join("\n")}`,
    { model: o.model, maxTurns: 2, effort: "medium", system: "You revise picture-book stories for young children. Answer only with the requested JSON.", schema: schemaOf(StorySchema) },
  );
  return normalizeStory(res.data, series);
}

// ---------- kid-safety reviewer ----------

const ReviewSchema = z.object({
  verdict: z.enum(["ok", "fix", "block"]),
  notes: z.array(z.string()).describe("Only the problems to fix, concrete and page-numbered; leave out checks that pass (empty when ok)"),
});

export function normalizeStoryReview(raw: unknown): StoryReview {
  const r = (raw ?? {}) as { verdict?: string; notes?: unknown[] };
  const verdict = r.verdict === "ok" || r.verdict === "block" ? r.verdict : "fix";
  // only problems are notes: a check that passed ("…. Pass.", "(pass)") is noise next to a real issue
  const passed = (n: string) => /(\bpass(ed|es)?\b\.?\)?\.?\s*$)|(\(pass(ed)?\)\.?\s*$)/i.test(n.trim());
  const notes = (Array.isArray(r.notes) ? r.notes : [])
    .filter((n): n is string => typeof n === "string" && !!n.trim() && !passed(n))
    .map((n) => n.trim().slice(0, 300))
    .slice(0, 10);
  return { verdict, notes };
}

export async function reviewStory(series: StorySeries, story: Pick<StoryState, "title" | "pages">, o: AiOpts): Promise<StoryReview> {
  const pages = story.pages.map((p, i) => `Page ${i + 1}: ${p.text}\n  (picture: ${p.scene})`).join("\n");
  const res = await askAgent(
    o.agent,
    `Review this picture-book story for children (${AGE_RULES[series.ageBand]}) before anyone illustrates it.

"${story.title}"
${pages}

Check:
1. Safety: nothing scary, violent, or unsafe a child could imitate; no stereotypes; no brand names or real people.
2. Original: not a retelling of an existing book, film or show.
3. Age fit: words and sentence length suit the age band; the page word limits are kept.
4. It works as a story: a clear beginning, a small problem, a warm ending.

verdict: "ok" if ready; "fix" with notes if a writer should change something; "block" only if the story is unsuitable for children at all.
notes: only what needs changing. Do not list checks that pass.`,
    { model: o.model, maxTurns: 2, effort: "medium", system: "You review children's stories for safety and quality. Answer only with the requested JSON.", schema: schemaOf(ReviewSchema) },
  );
  return normalizeStoryReview(res.data);
}

// ---------- drawings ----------

const SvgSchema = z.object({ svg: z.string() });

const drawingRules = (series: StorySeries) =>
  `Style: ${series.artStyle}. Flat storybook vector art with soft rounded shapes, thick dark-brown (#3b2a20) outlines about 6px, a warm limited palette, friendly and calm. Plain SVG shapes only: no text, no <image>, no <script>, no filters, no external references; gradients only if defined inside the fragment.`;

/** A character sprite: one SVG fragment in a 400×400 box, feet on y=390, centred on x=200, facing right. */
export async function drawCharacter(series: StorySeries, c: { name: string; description: string }, o: AiOpts): Promise<string> {
  const res = await askAgent(
    o.agent,
    `Draw ${c.name}: ${c.description}.
Output ONE SVG fragment (a <g> element, no <svg> wrapper) drawn inside a 400x400 box, standing with the feet at y=390, centred on x=200, facing right, filling most of the box.
${drawingRules(series)}`,
    { model: o.model, maxTurns: 2, effort: "low", system: "You are a children's picture-book illustrator who draws in clean, valid SVG.", schema: schemaOf(SvgSchema) },
  );
  const svg = sanitizeSvg(String((res.data as { svg?: string })?.svg ?? ""));
  if (!svg) throw new Error("The AI returned an empty drawing");
  return svg;
}

/** A page's scene (no characters: capy places them), for a 1080×1920 portrait page. */
export async function drawBackground(series: StorySeries, page: Pick<StoryPage, "scene" | "mood" | "cast">, o: AiOpts): Promise<string> {
  const where = page.cast.length ? `Characters will stand on the ground around x=${page.cast.map((c) => Math.round(c.x * 1080)).join(", ")} with their feet near y=1380: keep that ground open and flat.` : "No characters on this page.";
  const res = await askAgent(
    o.agent,
    `Draw the background for a portrait picture-book page, canvas 1080x1920.
Scene: ${page.scene}${page.mood ? ` (mood: ${page.mood})` : ""}
Output ONLY SVG elements (no <svg> wrapper): sky or walls, ground, scenery and props, covering the whole canvas. No people or animals. ${where}
Keep the bottom 420px calm and simple (read-along captions go there). Add a few charming details.
${drawingRules(series)}`,
    { model: o.model, maxTurns: 2, effort: "low", system: "You are a children's picture-book illustrator who draws in clean, valid SVG.", schema: schemaOf(SvgSchema) },
  );
  const svg = sanitizeSvg(String((res.data as { svg?: string })?.svg ?? ""));
  if (!svg) throw new Error("The AI returned an empty drawing");
  return svg;
}

// ---------- upload text ----------

const PublishSchema = z.object({
  ytTitle: z.string().describe("Max 100 chars, for parents, ends with #shorts"),
  description: z.string().describe("2-3 short lines for parents: what the story is about and what it teaches"),
  hashtags: z.array(z.string()).describe("4-8 hashtags without #"),
});

export async function storyPublish(series: StorySeries, story: Pick<StoryState, "title" | "moral" | "pages">, o: AiOpts) {
  const res = await askAgent(
    o.agent,
    `Write the upload text for a 1-minute animated read-aloud story Short for young children, "${story.title}" from the series "${series.title}" (${series.ageBand} year olds). Moral: ${story.moral}.
First page: ${story.pages[0]?.text ?? ""}
Address parents (platforms are 13+), never children. No emoji spam, no clickbait. Hashtags like bedtimestory, kidsstories, readaloud, shorts.`,
    { model: o.model, maxTurns: 2, effort: "low", system: "You write honest, warm upload text for children's story videos. Answer only with the requested JSON.", schema: schemaOf(PublishSchema) },
  );
  const p = PublishSchema.parse(res.data);
  return { ytTitle: p.ytTitle.slice(0, 100), description: p.description, hashtags: p.hashtags.map((h) => h.replace(/^#/, "")).slice(0, 8) };
}
