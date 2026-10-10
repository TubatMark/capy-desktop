import { z } from "zod";
import type { Word } from "./types";
import { askAgent } from "./agents";
import type { AgentId } from "../lib/types";

/** A run of spoken words shown as one translated caption line. Times are in source-video seconds. */
export interface Phrase {
  i: number;
  start: number;
  end: number;
  text: string;
}

const MAX_PHRASE = 4;
const MAX_GAP = 0.6;
const MIN_WORD = 0.12;

/** Split the words starting in [start, end) into phrases: at sentence punctuation, gaps over 0.6s, or 4s. */
export function splitPhrases(
  words: Word[],
  start: number,
  end: number,
): Phrase[] {
  const out: Phrase[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      i: out.length,
      start: cur[0]!.start,
      end: cur.at(-1)!.end,
      text: cur.map((x) => x.text).join(" "),
    });
    cur = [];
  };
  for (const w of words) {
    if (w.start < start || w.start >= end) continue;
    const prev = cur.at(-1);
    if (
      prev &&
      (w.start - prev.end > MAX_GAP || w.end - cur[0]!.start > MAX_PHRASE)
    )
      flush();
    cur.push(w);
    if (/[.!?…]["')\]]*$/.test(w.text)) flush();
  }
  flush();
  return out;
}

/**
 * English words for one phrase, timed across its span by character count. A phrase too short for 0.12s
 * per word stretches toward the next phrase's start, never past it.
 */
export function spreadWords(
  phrase: Phrase,
  en: string,
  nextStart?: number,
): Word[] {
  const parts = en.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const need = parts.length * MIN_WORD;
  let end = phrase.end;
  if (end - phrase.start < need)
    end = Math.max(
      end,
      Math.min(phrase.start + need, nextStart ?? phrase.start + need),
    );
  const span = Math.max(end - phrase.start, 0.01);
  const total = parts.reduce((n, p) => n + p.length, 0);
  // every word gets the minimum first (or an equal share when even that doesn't fit), the rest goes by length
  const floor = Math.min(MIN_WORD, span / parts.length);
  const spare = span - floor * parts.length;
  const out: Word[] = [];
  let t = phrase.start;
  parts.forEach((text, k) => {
    const last = k === parts.length - 1;
    const e = last
      ? end
      : Math.min(end, t + floor + (spare * text.length) / total);
    out.push({ text, start: t, end: e });
    t = e;
  });
  return out;
}

export interface Span {
  start: number;
  end: number;
}

/** Sort and merge overlapping or touching ranges. */
export function coalesce(ranges: Span[]): Span[] {
  const out: Span[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && r.start <= last.end + 1e-6)
      last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** True when one merged range contains all of `span`. */
export function covers(ranges: Span[], span: Span): boolean {
  return coalesce(ranges).some(
    (r) => r.start <= span.start + 0.01 && r.end >= span.end - 0.01,
  );
}

/**
 * The phrases to translate for `range`. Phrases are cut from the whole transcript, so their edges are the same
 * on every call: a range never splits a sentence, and two overlapping clips share the same translated lines.
 * Phrases overlapping `range` and not already inside `done` are returned, with each phrase's next phrase start.
 */
export function phrasesToTranslate(
  words: Word[],
  range: Span,
  done: Span[],
): { todo: Phrase[]; nextStart: Map<number, number> } {
  const all = splitPhrases(words, -Infinity, Infinity);
  const nextStart = new Map<number, number>();
  all.forEach((p, k) => {
    const next = all[k + 1];
    if (next) nextStart.set(p.i, next.start);
  });
  const todo = all.filter(
    (p) => p.end > range.start && p.start < range.end && !covers(done, p),
  );
  return { todo, nextStart };
}

/** Translated phrases → timed English words. Missing or empty translations keep the original text. */
export function applyTranslations(
  phrases: Phrase[],
  got: { i: number; en: string }[],
  nextStart?: Map<number, number>,
): Word[] {
  const byI = new Map(
    got.filter((g) => g.en?.trim()).map((g) => [g.i, g.en.trim()]),
  );
  return phrases.flatMap((p, k) =>
    spreadWords(
      p,
      byI.get(p.i) ?? p.text,
      nextStart ? nextStart.get(p.i) : phrases[k + 1]?.start,
    ),
  );
}

/** Replace the words of `existing` that start inside any of `spans` with `add`; keep everything sorted. */
export function mergeWords(
  existing: Word[],
  add: Word[],
  spans: Span[],
): Word[] {
  const inside = (w: Word) =>
    spans.some((r) => w.start >= r.start - 1e-6 && w.start < r.end + 1e-6);
  return [...existing.filter((w) => !inside(w)), ...add].sort(
    (a, b) => a.start - b.start,
  );
}

const TranslationSchema = z.object({
  phrases: z.array(z.object({ i: z.number(), en: z.string() })),
});

/** Translate phrases to US English caption words (one AI call, retried once for missing lines). */
export async function translatePhrases(
  phrases: Phrase[],
  nextStart: Map<number, number>,
  sourceLang: string | undefined,
  o: { agent: AgentId; model?: string },
): Promise<Word[]> {
  if (!phrases.length) return [];
  const { $schema: _d, ...schema } = z.toJSONSchema(TranslationSchema, {
    target: "draft-7",
  }) as Record<string, unknown>;
  const ask = async (list: Phrase[]) => {
    const lines = JSON.stringify(list.map((p) => ({ i: p.i, text: p.text })));
    const res = await askAgent(
      o.agent,
      `Translate each spoken caption line${sourceLang ? ` (language: ${sourceLang})` : ""} to natural, spoken US English for vertical-video captions. Keep it short and casual, one line in, one line out, same index. Do not merge or split lines.\n\n${lines}`,
      {
        task: "translation",
        model: o.model,
        maxTurns: 2,
        effort: "low",
        system:
          "You translate video captions. Answer only with the requested JSON.",
        schema,
        validate: (data) => {
          const parsed = TranslationSchema.safeParse(data);
          return (
            parsed.success &&
            parsed.data.phrases.length === list.length &&
            list.every(
              (p) =>
                parsed.data.phrases.filter((g) => g.i === p.i && g.en.trim())
                  .length === 1,
            )
          );
        },
      },
    );
    const parsed = TranslationSchema.safeParse(res.data);
    if (!parsed.success)
      throw new Error(
        `Translation output failed validation: ${parsed.error.message}`,
      );
    return parsed.data.phrases;
  };
  const got = await ask(phrases);
  return applyTranslations(phrases, got, nextStart);
}

/** Translate everything spoken in `range` (whole phrases) to US English caption words. */
export async function translateRange(
  words: Word[],
  range: Span,
  sourceLang: string | undefined,
  o: { agent: AgentId; model?: string },
): Promise<Word[]> {
  const { todo, nextStart } = phrasesToTranslate(words, range, []);
  return translatePhrases(todo, nextStart, sourceLang, o);
}
