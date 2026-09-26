import type { Word } from "./types";

/**
 * Parse YouTube's json3 caption format into words.
 * Auto captions carry per-word timings (segs[].tOffsetMs); manual captions usually
 * carry one segment per cue, so words get spread evenly across the cue.
 */
export function parseJson3(raw: string): Word[] {
  const j = JSON.parse(raw) as { events?: Json3Event[] };
  const words: Word[] = [];
  const events = (j.events ?? []).filter((e) => e.segs && e.segs.length > 0);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const base = e.tStartMs ?? 0;
    const dur = e.dDurationMs ?? (events[i + 1]?.tStartMs ?? base + 3000) - base;
    const segs = e.segs!.filter((s) => s.utf8 && s.utf8.trim() !== "" && s.utf8 !== "\n");
    if (segs.length === 0) continue;

    const timed = segs.some((s) => typeof s.tOffsetMs === "number");
    if (timed) {
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k]!;
        const start = base + (s.tOffsetMs ?? 0);
        const next = segs[k + 1];
        const end = next ? base + (next.tOffsetMs ?? 0) : base + dur;
        pushWords(words, s.utf8!, start / 1000, end / 1000);
      }
    } else {
      const text = segs.map((s) => s.utf8).join("");
      pushWords(words, text, base / 1000, (base + dur) / 1000);
    }
  }
  // json3 auto captions repeat lines as they scroll; drop exact duplicates at the same time.
  return dedupe(words);
}

function pushWords(out: Word[], text: string, start: number, end: number) {
  const toks = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (toks.length === 0) return;
  const span = Math.max(0.05, end - start);
  const each = span / toks.length;
  toks.forEach((t, i) => {
    out.push({ text: t, start: start + i * each, end: start + (i + 1) * each });
  });
}

function dedupe(words: Word[]): Word[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const out: Word[] = [];
  for (const w of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.text === w.text && Math.abs(prev.start - w.start) < 0.01) continue;
    out.push({ ...w });
  }
  // YouTube cue durations overlap the next cue; a word ends when the next one starts,
  // and never lingers more than MAX_WORD_SEC over silence.
  for (let i = 0; i < out.length; i++) {
    const w = out[i]!;
    const next = out[i + 1];
    if (next && next.start > w.start) w.end = Math.min(w.end, next.start);
    w.end = Math.max(w.start + 0.05, Math.min(w.end, w.start + MAX_WORD_SEC));
  }
  return out;
}

const MAX_WORD_SEC = 1.5;

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string; tOffsetMs?: number }[];
}

/** Parse whisper.cpp / mlx-whisper style JSON with word timings. */
export function parseWhisperJson(raw: string): Word[] {
  const j = JSON.parse(raw);
  const words: Word[] = [];
  // whisper.cpp: { transcription: [{ offsets:{from,to}, text, tokens:[{text, offsets}] }] }
  if (Array.isArray(j.transcription)) {
    for (const seg of j.transcription) {
      const toks = (seg.tokens ?? []).filter((t: any) => t.text && !/^\[_/.test(t.text));
      if (toks.length === 0) {
        pushWords(words, seg.text ?? "", seg.offsets.from / 1000, seg.offsets.to / 1000);
        continue;
      }
      // whisper.cpp tokens are sub-word; merge tokens that don't start with a space
      let cur: { text: string; start: number; end: number } | null = null;
      for (const t of toks) {
        const txt: string = t.text;
        if (cur && !txt.startsWith(" ")) {
          cur.text += txt;
          cur.end = t.offsets.to / 1000;
        } else {
          if (cur) words.push({ ...cur, text: cur.text.trim() });
          cur = { text: txt, start: t.offsets.from / 1000, end: t.offsets.to / 1000 };
        }
      }
      if (cur) words.push({ ...cur, text: cur.text.trim() });
    }
    return words.filter((w) => w.text);
  }
  // openai-whisper / mlx-whisper / faster-whisper: { segments:[{ words:[{word,start,end}] }] }
  if (Array.isArray(j.segments)) {
    for (const seg of j.segments) {
      if (Array.isArray(seg.words) && seg.words.length) {
        for (const w of seg.words) words.push({ text: String(w.word).trim(), start: w.start, end: w.end });
      } else {
        pushWords(words, seg.text ?? "", seg.start, seg.end);
      }
    }
    return words.filter((w) => w.text);
  }
  throw new Error("Unrecognized whisper JSON layout");
}

/** Transcript as lines prefixed with their start time in whole seconds, one line per ~`chunkSec`. */
export function transcriptForPrompt(words: Word[], chunkSec = 8): string {
  const lines: string[] = [];
  let bucket: string[] = [];
  let bucketStart = words[0]?.start ?? 0;
  for (const w of words) {
    if (w.start - bucketStart >= chunkSec && bucket.length) {
      lines.push(`[${Math.floor(bucketStart)}] ${bucket.join(" ")}`);
      bucket = [];
      bucketStart = w.start;
    }
    bucket.push(w.text);
  }
  if (bucket.length) lines.push(`[${Math.floor(bucketStart)}] ${bucket.join(" ")}`);
  return lines.join("\n");
}

/** Words that START within [start, end), with times rebased to the clip start. */
export function wordsInRange(words: Word[], start: number, end: number): Word[] {
  return words
    .filter((w) => w.start >= start - 0.1 && w.start < end)
    .map((w) => ({
      text: w.text,
      start: Math.max(0, w.start - start),
      end: Math.min(end - start, w.end - start),
    }));
}

const SENTENCE_END = /[.!?…]["')\]]?$/;
/** Start-to-start gap that counts as a pause (auto captions rarely have punctuation). */
const PAUSE_SEC = 1.0;

/** True if a new thought plausibly starts at words[i]. */
function isBoundaryBefore(words: Word[], i: number): boolean {
  if (i <= 0 || i >= words.length) return true;
  const prev = words[i - 1]!;
  return SENTENCE_END.test(prev.text) || words[i]!.start - prev.start >= PAUSE_SEC;
}

/**
 * Snap a clip's edges to natural boundaries:
 * start -> the beginning of the word at `start`, walking back up to `slack`s to a
 * sentence end or pause; end -> the end of the word at `end`, walking forward up
 * to `slack`s to a sentence end or pause.
 */
export function snapToWords(words: Word[], start: number, end: number, slack = 2.5): { start: number; end: number } {
  if (words.length === 0) return { start, end };

  let si = words.findIndex((w) => w.end > start);
  if (si < 0) si = words.length - 1;
  let s = words[si]!.start;
  for (let i = si; i >= 0 && words[si]!.start - words[i]!.start <= slack; i--) {
    if (isBoundaryBefore(words, i)) {
      s = words[i]!.start;
      break;
    }
  }

  let ei = words.findIndex((w) => w.end >= end);
  if (ei < 0) ei = words.length - 1;
  let e = words[ei]!.end;
  for (let i = ei; i < words.length && words[i]!.end - words[ei]!.end <= slack; i++) {
    if (SENTENCE_END.test(words[i]!.text) || isBoundaryBefore(words, i + 1)) {
      e = words[i]!.end;
      break;
    }
  }
  return { start: Math.max(0, s - 0.15), end: e + 0.25 };
}
