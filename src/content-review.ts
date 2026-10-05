import { z } from "zod";
import { askAgent } from "./agents";
import type { AgentId, ContentReview } from "../lib/types";

/**
 * The AI content reviewer: one look at a finished clip (its final words and the text it will be posted with) before
 * it reaches the user's own review. It checks what a platform or a viewer would object to, not whether the moment is
 * good (the pick reviewer did that).
 */

export interface ContentInput {
  videoTitle: string;
  channel?: string;
  clipTitle: string;
  hook: string;
  /** What viewers read on screen: the English captions when translated, else the spoken words. */
  transcript: string;
  /** The spoken words when the captions are a translation. */
  original?: string;
  sourceLang?: string;
  ytTitle?: string;
  caption?: string;
  hashtags?: string[];
}

const Schema = z.object({
  verdict: z.enum(["ok", "caution", "block"]),
  summary: z.string().describe("One or two sentences for the editor"),
  issues: z.array(z.object({ kind: z.string().describe("policy | misleading | translation | reused_content | personal_data | other"), note: z.string() })),
  title: z.string().optional().describe("A better YouTube title, only if the current one is misleading or weak"),
});

export function buildContentPrompt(i: ContentInput): string {
  return `A vertical short was cut from "${i.videoTitle}"${i.channel ? ` by ${i.channel}` : ""} and is about to be posted to YouTube Shorts, Instagram Reels and TikTok.

On-screen hook: ${i.hook}
Clip title: ${i.clipTitle}
YouTube title: ${i.ytTitle ?? "(none)"}
Caption: ${i.caption ?? "(none)"}
Hashtags: ${(i.hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ") || "(none)"}

Captions viewers read:
${i.transcript}
${i.original ? `\nOriginal-language transcript (${i.sourceLang ?? "unknown"}):\n${i.original}\n` : ""}
Review it before a human editor does. Check:
1. Platform policy: graphic violence, sexual content, hate or harassment, dangerous acts someone could copy, medical or financial claims, minors in unsafe situations.
2. Misleading: does the hook, title or caption promise something the clip doesn't show?
3. ${i.original ? "Translation: do the English captions keep the meaning and read naturally? Flag lines that change the meaning." : "Captions: anything garbled or obviously mis-transcribed?"}
4. Reused content: is there a credit to the original creator in the caption? Is it a fair, self-contained excerpt rather than the whole video?
5. Personal data: phone numbers, addresses or other private details said out loud.

verdict: "ok" if it can go out as is; "caution" if the editor should look at something first; "block" only for a real policy problem or something seriously misleading. Keep notes short and concrete.`;
}

export function normalizeContentReview(raw: unknown, at: number): ContentReview {
  const r = (raw ?? {}) as { verdict?: string; summary?: string; issues?: { kind?: string; note?: string }[]; title?: string };
  const verdict = r.verdict === "ok" || r.verdict === "block" ? r.verdict : "caution";
  const title = typeof r.title === "string" && r.title.trim() && r.title.trim().length <= 100 ? r.title.trim() : undefined;
  return {
    verdict,
    summary: String(r.summary ?? "").slice(0, 400),
    issues: (Array.isArray(r.issues) ? r.issues : [])
      .filter((x) => x && typeof x.note === "string")
      .slice(0, 8)
      .map((x) => ({ kind: String(x.kind ?? "other").slice(0, 40), note: String(x.note).slice(0, 300) })),
    ...(title ? { title } : {}),
    at,
  };
}

/** When the reviewer can't run: the clip still reaches the user, marked for a careful look. */
export function reviewUnavailable(reason: string, at: number): ContentReview {
  return { verdict: "caution", summary: `AI review unavailable: ${reason}. Check this clip yourself.`, issues: [], at };
}

export async function reviewContent(i: ContentInput, o: { agent: AgentId; model?: string }): Promise<ContentReview> {
  const { $schema: _d, ...schema } = z.toJSONSchema(Schema, { target: "draft-7" }) as Record<string, unknown>;
  try {
    const res = await askAgent(o.agent, buildContentPrompt(i), {
      model: o.model,
      maxTurns: 2,
      effort: "low",
      system: "You review short-form video posts for platform policy and honesty before a human editor approves them. Answer only with the requested JSON.",
      schema,
    });
    return normalizeContentReview(res.data, Date.now());
  } catch (e) {
    return reviewUnavailable(e instanceof Error ? e.message.split("\n")[0]!.slice(0, 120) : String(e), Date.now());
  }
}
