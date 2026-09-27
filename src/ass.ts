import type { Word } from "./types";
import { hexToAss, normalizeLook, type Look } from "../lib/look";

export interface CaptionStyle {
  /** Font family; must be installed. Arial Black / Helvetica ship with macOS. */
  font: string;
  size: number;
  /** ASS colors are &HAABBGGRR. */
  primary: string;
  highlight: string;
  outline: string;
  outlineWidth: number;
  /** Vertical margin from the bottom, in pixels of the 1080x1920 canvas. */
  marginV: number;
  /** Max words shown in one caption group. */
  groupWords: number;
  /** Max seconds one group stays on screen. */
  groupSec: number;
  /** Max characters per group so a line fits the 1080px width at this font size. */
  groupChars: number;
  uppercase: boolean;
  /** Opaque box behind the caption text (ASS BorderStyle 3); the box is the outline colour at a dark alpha. */
  box: boolean;
  hookSize: number;
  /** Hook text and box colours (&HAABBGGRR). */
  hookPrimary: string;
  hookBack: string;
  /** Hook distance from the top, in pixels of the 1080x1920 canvas. */
  hookMarginV: number;
}

export const STYLES: Record<string, CaptionStyle> = {
  bold: {
    font: "Arial Black",
    size: 76,
    primary: "&H00FFFFFF",
    highlight: "&H0000E5FF", // yellow (BGR)
    outline: "&H00000000",
    outlineWidth: 5,
    marginV: 560,
    groupWords: 3,
    groupSec: 2.2,
    groupChars: 14,
    uppercase: true,
    box: false,
    hookSize: 84,
    hookPrimary: "&H00FFFFFF",
    hookBack: "&HB4000000",
    hookMarginV: 300,
  },
  clean: {
    font: "Helvetica",
    size: 64,
    primary: "&H00FFFFFF",
    highlight: "&H00FFFFFF",
    outline: "&H80000000",
    outlineWidth: 3,
    marginV: 520,
    groupWords: 5,
    groupSec: 2.5,
    groupChars: 24,
    uppercase: false,
    box: false,
    hookSize: 76,
    hookPrimary: "&H00FFFFFF",
    hookBack: "&HB4000000",
    hookMarginV: 300,
  },
};

/** Alpha of the caption box (ASS: 0 opaque … 255 transparent) when `box` is on. */
const BOX_ALPHA = 0x60;

/** Replace the alpha byte of an &HAABBGGRR colour. */
function withAlpha(assColor: string, alpha: number): string {
  const m = /^&H([0-9A-F]{2})([0-9A-F]{6})$/i.exec(assColor);
  return m ? `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${m[2]!.toUpperCase()}` : assColor;
}

/**
 * A caption style for a base plus a per-video look. Without a look this is STYLES[base] itself
 * (LOOK_DEFAULTS reproduce it); with one, the look's sizes, positions and colours are applied.
 * The look is normalized first, so partial or out-of-range values from older jobs are fine.
 */
export function styleFor(base: "bold" | "clean", look?: Look | null): CaptionStyle {
  const s = STYLES[base]!;
  if (!look) return { ...s };
  const l = normalizeLook(look, base);
  return {
    ...s,
    size: l.size,
    marginV: Math.round(l.bottom * 1920),
    groupWords: l.wordsPerLine,
    // the character budget was tuned for the base size; scale it so a line still fits the width
    groupChars: Math.max(6, Math.round((s.groupChars * s.size) / l.size)),
    primary: hexToAss(l.text, 0),
    highlight: hexToAss(l.highlight, 0),
    outline: hexToAss(l.outline, 0),
    outlineWidth: l.outlineWidth,
    box: l.box,
    hookSize: l.hook.size,
    hookPrimary: hexToAss(l.hook.text, 0),
    hookBack: hexToAss(l.hook.box, 0xb4),
    hookMarginV: Math.round(l.hook.top * 1920),
  };
}

export interface HookSpec {
  text: string;
  /** seconds the hook stays on screen */
  seconds: number;
}

const PAUSE_SEC = 1.0;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;

/** Remove things that shouldn't be burned in: [Music]-style tags, >> speaker marks, emoji (libass can't draw them). */
export function cleanCaptionWords(words: Word[]): Word[] {
  return words
    .filter((w) => !/^\[.*\]$/.test(w.text) && w.text !== ">>" && w.text !== "♪")
    .map((w) => ({ ...w, text: w.text.replace(EMOJI, "").trim() }))
    .filter((w) => w.text.length > 0);
}

export function stripEmoji(text: string): string {
  return text.replace(EMOJI, "").replace(/\s+/g, " ").trim();
}

/** Group words into short caption chunks (by count, characters, duration, pauses, and sentence ends). */
export function groupWords(words: Word[], maxWords: number, maxSec: number, maxChars = 18): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  const chars = (g: Word[]) => g.reduce((n, w) => n + w.text.length, 0) + Math.max(0, g.length - 1);
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.start >= PAUSE_SEC || chars(cur) + 1 + w.text.length > maxChars)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
    const span = w.end - cur[0]!.start;
    const endsSentence = /[.!?…]$/.test(w.text);
    if (cur.length >= maxWords || span >= maxSec || (endsSentence && cur.length >= 2)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function escapeAss(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, "\\N");
}

/**
 * Build an ASS subtitle file for a 1080x1920 canvas. With a highlight color, each
 * group gets one Dialogue per word so the spoken word lights up while the rest of
 * the group stays visible; without one, one Dialogue per group.
 */
export function buildAss(words: Word[], style: CaptionStyle, hook?: HookSpec): string {
  const capBack = style.box ? withAlpha(style.outline, BOX_ALPHA) : "&H80000000";
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${style.font},${style.size},${style.primary},${style.primary},${style.outline},${capBack},-1,0,0,0,100,100,0,0,${style.box ? 3 : 1},${style.outlineWidth},2,2,70,70,${style.marginV},1
Style: Hook,${style.font},${style.hookSize},${style.hookPrimary},${style.hookPrimary},&H00000000,${style.hookBack},-1,0,0,0,100,100,1,0,3,18,0,8,70,70,${style.hookMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines: string[] = [];
  const hookText = hook ? stripEmoji(hook.text) : "";
  if (hook && hookText) {
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(hook.seconds)},Hook,,0,0,0,,${escapeAss(hookText.toUpperCase())}`);
  }
  const fmt = (w: Word) => escapeAss(style.uppercase ? w.text.toUpperCase() : w.text);
  const karaoke = style.highlight !== style.primary;
  const groups = groupWords(cleanCaptionWords(words), style.groupWords, style.groupSec, style.groupChars);
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]!;
    const last = g[g.length - 1]!;
    const next = groups[gi + 1]?.[0];
    const groupEnd = next ? Math.min(last.end + 0.3, next.start) : last.end + 0.4;
    if (!karaoke) {
      if (groupEnd > g[0]!.start) lines.push(`Dialogue: 0,${assTime(g[0]!.start)},${assTime(groupEnd)},Cap,,0,0,0,,${g.map(fmt).join(" ")}`);
      continue;
    }
    for (let i = 0; i < g.length; i++) {
      const start = i === 0 ? g[0]!.start : g[i]!.start;
      const end = i === g.length - 1 ? groupEnd : g[i + 1]!.start;
      if (end <= start) continue;
      const text = g.map((x, k) => (k === i ? `{\\c${style.highlight}}${fmt(x)}{\\c${style.primary}}` : fmt(x))).join(" ");
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${text}`);
    }
  }
  return header + lines.join("\n") + "\n";
}
