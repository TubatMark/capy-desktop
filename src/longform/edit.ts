import { cleanCaptionWords } from "../ass";
import { escapeFilterPath } from "../render";
import type { Word } from "../types";

/**
 * The edit of a long video, as pure functions: which moments of the footage to keep, the ASS text drawn over them, and
 * the ffmpeg arguments for each section. Every section starts and ends on a short dip to black, so sections can be
 * joined without re-encoding and a crash only loses the section being rendered.
 */

export const W = 1920;
export const H = 1080;
export const FPS = 30;
const FADE = 0.25;
/** Keeps ffmpeg's frame buffers small while the Mac is doing other things. */
export const LOW_MEMORY = ["-threads", "4", "-filter_threads", "2", "-filter_complex_threads", "2"];
const LUFS = "loudnorm=I=-14:TP=-1.5:LRA=11";
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface Range {
  start: number;
  end: number;
}

/**
 * The parts of [start, end] worth keeping, in source seconds: starts on the first word, ends just after the last one,
 * and shortens long silent stretches to `keepGap`. A gap has to be long before it's cut, because streams often have
 * action with no talking.
 */
export function keepRanges(words: Word[], start: number, end: number, o: { maxGap?: number; keepGap?: number } = {}): Range[] {
  const maxGap = o.maxGap ?? 3;
  const keepGap = o.keepGap ?? 1.2;
  const inside = words.filter((w) => w.start >= start && w.end <= end);
  if (!inside.length) return [{ start, end }];
  const ranges: Range[] = [];
  let from = Math.max(start, inside[0]!.start - 0.2);
  for (let i = 1; i < inside.length; i++) {
    const gap = inside[i]!.start - inside[i - 1]!.end;
    if (gap > maxGap) {
      ranges.push({ start: r3(from), end: r3(inside[i - 1]!.end + keepGap / 2) });
      from = inside[i]!.start - keepGap / 2;
    }
  }
  ranges.push({ start: r3(from), end: r3(Math.min(end, inside[inside.length - 1]!.end + 0.5)) });
  return ranges;
}

export const rangesLength = (ranges: Range[]) => r3(ranges.reduce((a, r) => a + r.end - r.start, 0));

/** Where a source moment lands in the cut, or null if it was cut out. */
export function mapTime(ranges: Range[], t: number): number | null {
  let out = 0;
  for (const r of ranges) {
    if (t >= r.start && t <= r.end) return r3(out + t - r.start);
    out += r.end - r.start;
  }
  return null;
}

/** Words of the cut, timed to the cut. */
export function wordsInCut(words: Word[], ranges: Range[]): Word[] {
  const out: Word[] = [];
  for (const w of cleanCaptionWords(words)) {
    const start = mapTime(ranges, w.start);
    const end = mapTime(ranges, w.end);
    if (start !== null && end !== null) out.push({ ...w, start, end });
  }
  return out;
}

// ---------- text on screen ----------

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
/** Text is shown as written: drop what ASS would read as an override, and what it can't draw. */
export function assText(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\\/g, "/")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Rank,Arial Black,230,&H0000E5FF,&H0000E5FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,5,80,80,0,1
Style: Title,Arial Black,70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,5,160,160,0,1
Style: Line,Helvetica Neue,44,&H00E6E6E6,&H00E6E6E6,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,240,240,0,1
Style: Credit,Helvetica Neue,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,10,0,9,40,40,36,1
Style: Lower,Arial Black,44,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,3,14,0,1,60,60,60,1
Style: Cap,Arial Black,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,1,2,180,180,64,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const event = (style: string, start: number, end: number, text: string, tags = "") =>
  `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,${tags}${text}\n`;
const at = (y: number) => `{\\pos(${W / 2},${y})\\fad(250,200)}`;

/** The rank card (or an intro/outro card when there's no rank). */
export function cardAss(o: { rank?: number; title: string; line?: string; seconds: number; credit?: string }): string {
  let out = HEADER;
  if (o.rank !== undefined) {
    out += event("Rank", 0, o.seconds, `#${o.rank}`, at(320));
    out += event("Title", 0, o.seconds, assText(o.title), at(590));
  } else out += event("Title", 0, o.seconds, assText(o.title), at(o.line ? 360 : 500));
  if (o.line) out += event("Line", 0, o.seconds, assText(o.line), at(o.rank !== undefined ? 800 : 640));
  if (o.credit) out += event("Credit", 0, o.seconds, assText(o.credit));
  return out;
}

/** Burned-in captions never spell a slur out; the words stay in the creator's own audio. */
const SLURS = /\b(nigg)(a|as|er|ers|ah|uh)\b|\b(fagg?)(ot|ots|)\b|\b(retard)(ed|s|)\b|\b(chink|gook|spic|kike|tranny)(s|)\b/gi;
export const maskSlurs = (text: string) => text.replace(SLURS, (m) => `${m[0]}${"*".repeat(m.length - 1)}`);

/** Group words into short captions, no longer than `maxSec` on screen. */
export function captionGroups(words: Word[], maxWords = 6, maxSec = 3): { start: number; end: number; text: string }[] {
  const groups: { start: number; end: number; text: string }[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    groups.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: maskSlurs(assText(cur.map((w) => w.text).join(" "))) });
    cur = [];
  };
  for (const w of words) {
    const last = cur[cur.length - 1];
    if (last && (cur.length >= maxWords || w.end - cur[0]!.start > maxSec || w.start - last.end > 0.8)) flush();
    cur.push(w);
  }
  flush();
  return groups.filter((g) => g.text);
}

/** Over a clip: where it came from all the way through, its rank and title at the start, and captions. */
export function clipAss(o: { rank?: number; title?: string; credit: string; seconds: number; words: Word[] }): string {
  let out = HEADER + event("Credit", 0, o.seconds, assText(o.credit));
  if (o.title) out += event("Lower", 0.3, Math.min(5, o.seconds), `${o.rank !== undefined ? `#${o.rank}  ` : ""}${assText(o.title)}`, "{\\fad(200,300)}");
  for (const g of captionGroups(o.words)) out += event("Cap", g.start, Math.min(g.end + 0.15, o.seconds), g.text);
  return out;
}

// ---------- ffmpeg ----------

export function videoEncoder(enc: string): string[] {
  const common = ["-r", String(FPS), "-g", String(FPS * 2), "-pix_fmt", "yuv420p", "-video_track_timescale", "30000"];
  return enc === "h264_videotoolbox"
    ? ["-c:v", enc, "-b:v", "10M", "-maxrate", "14M", "-profile:v", "high", "-allow_sw", "1", ...common]
    : ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-profile:v", "high", ...common];
}
const AUDIO = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];
const fit = `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
/** Streams show live chat and counters in this corner, and chat can hold anything. The credit sits on top of the blur. */
const CHAT_BOX = { x: 1490, y: 0, w: 430, h: 340 };
const CHAT_FEATHER = 48;
export const hideChat = (input: string, output: string) =>
  [
    `[${input}]split[hc0][hc1]`,
    `[hc1]crop=${CHAT_BOX.w}:${CHAT_BOX.h}:${CHAT_BOX.x}:${CHAT_BOX.y},boxblur=24:2,format=yuva420p[hc2]`,
    // a mask drawn once and held: the blur fades out towards the picture instead of ending on a hard line
    `color=white:s=${CHAT_BOX.w}x${CHAT_BOX.h}:r=${FPS},format=gray,geq=lum='255*min(1\\,min(X/${CHAT_FEATHER}\\,(H-1-Y)/${CHAT_FEATHER}))',loop=loop=-1:size=1:start=0[hc3]`,
    `[hc2][hc3]alphamerge=shortest=1[hc4]`,
    `[hc0][hc4]overlay=${CHAT_BOX.x}:${CHAT_BOX.y}:shortest=1:format=auto[${output}]`,
  ].join(";");
const fades = (seconds: number) => `fade=t=in:st=0:d=${FADE},fade=t=out:st=${r3(seconds - FADE)}:d=${FADE}`;
const audioFades = (seconds: number) => `afade=t=in:st=0:d=${FADE},afade=t=out:st=${r3(seconds - FADE)}:d=${FADE}`;

/**
 * A clip section: the kept ranges of one footage file, joined. Commands run in the section's folder and name the ASS
 * file bare, so no folder name has to survive filter escaping.
 */
export function clipArgs(o: { footage: string; ranges: Range[]; ass: string; out: string; enc: string }): string[] {
  const seconds = rangesLength(o.ranges);
  const parts = o.ranges.map(
    (r, i) => `[0:v]trim=${r3(r.start)}:${r3(r.end)},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=${r3(r.start)}:${r3(r.end)},asetpts=PTS-STARTPTS[a${i}]`,
  );
  const inputs = o.ranges.map((_, i) => `[v${i}][a${i}]`).join("");
  const filter = [
    ...parts,
    `${inputs}concat=n=${o.ranges.length}:v=1:a=1[vc][ac]`,
    `[vc]${fit}[vf]`,
    hideChat("vf", "vh"),
    `[vh]ass=filename=${escapeFilterPath(o.ass)},${fades(seconds)},format=yuv420p[v]`,
    `[ac]aresample=48000,${LUFS},aresample=48000,${audioFades(seconds)}[a]`,
  ].join(";");
  return ["-y", "-hide_banner", "-loglevel", "error", ...LOW_MEMORY, "-i", o.footage, "-filter_complex", filter, "-map", "[v]", "-map", "[a]", ...videoEncoder(o.enc), ...AUDIO, "-t", String(seconds), o.out];
}

/** A card: the footage blurred behind the text, its sound low under the narrator. */
export function cardArgs(o: { footage: string; offset: number; narration: string; seconds: number; lead: number; ass: string; out: string; enc: string }): string[] {
  const filter = [
    `[0:v]fps=${FPS},scale=480:270:force_original_aspect_ratio=increase,crop=480:270,boxblur=10:2,scale=${W}:${H},eq=brightness=-0.3,setsar=1,ass=filename=${escapeFilterPath(o.ass)},${fades(o.seconds)},format=yuv420p[v]`,
    `[0:a]aresample=48000,volume=0.08,apad[bg]`,
    `[1:a]aresample=48000,adelay=delays=${Math.round(o.lead * 1000)}:all=1,${LUFS},aresample=48000,apad[n]`,
    `[bg][n]amix=inputs=2:normalize=0:duration=longest,atrim=0:${r3(o.seconds)},${audioFades(o.seconds)}[a]`,
  ].join(";");
  return [
    "-y", "-hide_banner", "-loglevel", "error", ...LOW_MEMORY,
    "-ss", String(r3(o.offset)), "-stream_loop", "-1", "-i", o.footage,
    "-i", o.narration,
    "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
    ...videoEncoder(o.enc), ...AUDIO, "-t", String(r3(o.seconds)), o.out,
  ];
}

/** Sections in order, joined without re-encoding. */
export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}
export function assembleArgs(list: string, out: string): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out];
}

/** A cover frame with big words on it. */
export function thumbAss(text: string): string {
  return `${HEADER.replace("Style: Title,Arial Black,70", "Style: Title,Arial Black,150")}${event("Title", 0, 2, assText(text), `{\\pos(${W / 2},${H - 240})\\bord10}`)}`;
}
/** A small still for the AI to look at when choosing the cover. */
export function candidateArgs(footage: string, offset: number, out: string): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(r3(offset)), "-i", footage, "-filter_complex", `[0:v]${fit}[vf];${hideChat("vf", "vh")};[vh]scale=640:-2[v]`, "-map", "[v]", "-frames:v", "1", "-q:v", "6", out];
}
export function thumbArgs(o: { footage: string; offset: number; ass: string; out: string }): string[] {
  return [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", String(r3(o.offset)), "-i", o.footage,
    "-filter_complex", `[0:v]${fit},eq=contrast=1.08:saturation=1.2[vf];${hideChat("vf", "vh")};[vh]ass=filename=${escapeFilterPath(o.ass)},scale=1280:720[v]`,
    "-map", "[v]", "-frames:v", "1", "-q:v", "3", o.out,
  ];
}

/** YouTube turns "0:00 Title" lines into chapters when the first is 0:00 and each runs at least 10 seconds. */
export function chapterLines(parts: { title: string; seconds: number }[]): string[] {
  const merged: { title: string; start: number }[] = [];
  let at = 0;
  for (const p of parts) {
    if (p.title) merged.push({ title: p.title, start: at });
    at += p.seconds;
  }
  if (merged.length) merged[0]!.start = 0;
  const kept = merged.filter((m, i) => i === merged.length - 1 ? at - m.start >= 10 : merged[i + 1]!.start - m.start >= 10);
  const stamp = (t: number) => {
    const s = Math.floor(t);
    const h = Math.floor(s / 3600);
    const mm = Math.floor(s / 60) % 60;
    return `${h ? `${h}:${String(mm).padStart(2, "0")}` : mm}:${String(s % 60).padStart(2, "0")}`;
  };
  return kept.length >= 3 ? kept.map((m) => `${stamp(m.start)} ${m.title}`) : [];
}

/** Long black or silent stretches, read from `blackdetect` and `silencedetect` output. */
export function readProblems(log: string): string[] {
  const out: string[] = [];
  for (const m of log.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)) out.push(`${Number(m[3]).toFixed(1)}s of black at ${Math.round(Number(m[1]))}s`);
  for (const m of log.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)) out.push(`${Number(m[2]).toFixed(1)}s of silence ending at ${Math.round(Number(m[1]))}s`);
  return out;
}
