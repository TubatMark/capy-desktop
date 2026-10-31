import { z } from "zod";
import { askAgent } from "./agents";
import { assText, maskSlurs } from "./longform/edit";
import { escapeFilterPath } from "./render";
import type { AiOpts } from "./story/write";

/**
 * A Short with something of the channel's own: the host's take over the opening seconds, with the clip's sound low,
 * then the host's verdict after the clip's own ending, so the punchline is never talked over.
 */

const strip = (s: Record<string, unknown>) => {
  const { $schema: _d, ...rest } = s;
  return rest;
};
const Schema = z.object({
  opening: z.string().describe("Spoken over the first seconds, 6-12 words: take a side, or ask a question people will want to answer. Never a description of what's on screen"),
  middle: z.string().describe("Spoken once partway through, 5-10 words: your reaction or a point you'd argue, as if watching along"),
  verdict: z.string().describe("Spoken after the clip, 8-16 words: a verdict people could disagree with, with a reason, ending by asking what the viewer thinks"),
});
export type ShortCommentary = z.infer<typeof Schema>;

export function commentaryPrompt(o: { creator: string; title: string; reason?: string; excerpt: string }): string {
  return `You are the host of a clips channel, adding your own take to this moment from ${o.creator}'s stream.

Moment: "${o.title}"
Why it stood out: ${o.reason ?? "n/a"}
What is said: ${o.excerpt}

Write what the host says. Take a real side that a viewer could argue with in the comments, not a safe observation. YouTube doesn't count a voice-over that describes the screen as original, so never narrate what's happening.
- Say only what the clip supports. Don't invent facts, motives or background about real people, and don't state what someone privately feels as fact.
- Don't spoil the punchline in the opening.
- Sound like a person talking: short, plain, no hype words like "insane" or "you won't believe".`;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const MAX_OPENING_WORDS = 16;
const MAX_MIDDLE_WORDS = 14;
const MAX_VERDICT_WORDS = 26;
export const fitsLength = (c: ShortCommentary) => words(c.opening) <= MAX_OPENING_WORDS && words(c.middle) <= MAX_MIDDLE_WORDS && words(c.verdict) <= MAX_VERDICT_WORDS;

export async function writeCommentary(o: Parameters<typeof commentaryPrompt>[0], ai: AiOpts): Promise<ShortCommentary> {
  let prompt = commentaryPrompt(o);
  // a long opening talks over too much of the clip: ask once more before leaving the clip plain
  for (let attempt = 0; ; attempt++) {
    const res = await askAgent(ai.agent, prompt, {
      task: "metadata",
      model: ai.model,
      maxTurns: 2,
      effort: "low",
      system: "You write short spoken commentary for a clips channel. Answer only with the requested JSON.",
      schema: strip(z.toJSONSchema(Schema, { target: "draft-7" }) as Record<string, unknown>),
    });
    const out = Schema.parse(res.data);
    const trimmed = { opening: out.opening.trim(), middle: out.middle.trim(), verdict: out.verdict.trim() };
    if (fitsLength(trimmed)) return trimmed;
    if (attempt >= 2) throw new Error(`The commentary came out too long (${words(trimmed.opening)}, ${words(trimmed.middle)} and ${words(trimmed.verdict)} words)`);
    prompt = `${commentaryPrompt(o)}\n\nYour last try was too long. The opening must be at most ${MAX_OPENING_WORDS} words, the middle ${MAX_MIDDLE_WORDS} and the verdict ${MAX_VERDICT_WORDS}.`;
  }
}

// ---------- the edit ----------

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Take,Arial Black,50,&H00FFFFFF,&H00FFFFFF,&H00E08A2E,&H00E08A2E,-1,0,0,0,100,100,0,0,3,18,0,5,90,90,0,1
Style: Verdict,Arial Black,70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,5,0,5,90,90,0,1
Style: Ask,Helvetica Neue,44,&H0000E5FF,&H0000E5FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,5,90,90,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
const line = (style: string, start: number, end: number, y: number, text: string) =>
  `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,{\\pos(540,${y})\\fad(150,150)}${maskSlurs(assText(text))}\n`;

/**
 * Where the host's mid-clip comment goes, in seconds into the clip: the longest pause in the middle stretch, so it talks
 * over as little as possible. Clips too short to have a middle get none.
 */
export function middleAt(words: { start: number; end: number }[], clipSeconds: number): number | undefined {
  if (clipSeconds < 18) return undefined;
  let best = clipSeconds * 0.5;
  let longest = -1;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i]!.start - words[i - 1]!.end;
    const at = words[i - 1]!.end;
    if (at >= clipSeconds * 0.35 && at <= clipSeconds * 0.7 && gap > longest) {
      longest = gap;
      best = at;
    }
  }
  return r3(best);
}

export function commentaryAss(o: { opening: string; openingEnd: number; middle?: { text: string; start: number; end: number }; verdict: string; outroStart: number; outroEnd: number }): string {
  return (
    HEADER +
    line("Take", 0.1, o.openingEnd, 620, o.opening) +
    (o.middle ? line("Take", o.middle.start, o.middle.end, 620, o.middle.text) : "") +
    line("Verdict", o.outroStart + 0.1, o.outroEnd, 860, o.verdict)
  );
}

/** A little louder than the clip, which sits at -14: the host has to be clearly heard on a phone. */
const LUFS = "loudnorm=I=-12:TP=-1.5:LRA=11";
/** Time after the verdict before the Short ends. */
const OUTRO_TAIL = 0.6;
/** The clip's own sound under the host. */
const DUCK = 0.12;

export const outroLength = (verdictSeconds: number) => r3(verdictSeconds + OUTRO_TAIL);
/** ffmpeg arguments: runs in the captions file's folder and names that file bare. */
export function commentaryArgs(o: {
  clip: string;
  clipSeconds: number;
  opening: string;
  openingSeconds: number;
  middle?: { file: string; at: number; seconds: number };
  verdict: string;
  verdictSeconds: number;
  ass: string;
  out: string;
  enc: string;
}): { args: string[]; added: number } {
  const added = outroLength(o.verdictSeconds);
  // the last seconds of the clip keep moving behind the verdict, shorter clips start over
  const from = r3(Math.max(0, o.clipSeconds - added));
  const hold = r3(o.openingSeconds + 0.25);
  const total = r3(o.clipSeconds + added);
  const filter = [
    `[0:v]split[main][tail0]`,
    `[0:a]asplit[clipa][taila0]`,
    `[tail0]trim=start=${from},setpts=PTS-STARTPTS,scale=270:480,boxblur=8:2,scale=1080:1920,eq=brightness=-0.32,setsar=1[tail]`,
    `[main]setsar=1[mainv]`,
    `[mainv][tail]concat=n=2:v=1:a=0,ass=filename=${escapeFilterPath(o.ass)},format=yuv420p[v]`,
    `[clipa]aresample=48000,volume=${DUCK}:enable='${o.middle ? `lt(t,${hold})+between(t,${r3(o.middle.at - 0.1)},${r3(o.middle.at + o.middle.seconds + 0.25)})` : `lt(t,${hold})`}'[cliplow]`,
    `[1:a]aresample=48000,${LUFS},aresample=48000,adelay=delays=100:all=1,apad=whole_dur=${r3(o.clipSeconds)}[take]`,
    ...(o.middle ? [`[3:a]aresample=48000,${LUFS},aresample=48000,adelay=delays=${Math.round(o.middle.at * 1000)}:all=1,apad=whole_dur=${r3(o.clipSeconds)}[mid]`] : []),
    `[cliplow][take]${o.middle ? "[mid]" : ""}amix=inputs=${o.middle ? 3 : 2}:normalize=0:duration=first,atrim=0:${r3(o.clipSeconds)},asetpts=PTS-STARTPTS[front]`,
    `[taila0]atrim=start=${from},asetpts=PTS-STARTPTS,aresample=48000,volume=${DUCK},apad=whole_dur=${added},atrim=0:${added}[low]`,
    `[2:a]aresample=48000,${LUFS},aresample=48000,apad=whole_dur=${added},atrim=0:${added}[say]`,
    `[low][say]amix=inputs=2:normalize=0:duration=first[back]`,
    `[front][back]concat=n=2:v=0:a=1,alimiter=limit=0.95,afade=t=out:st=${r3(total - 0.25)}:d=0.25[a]`,
  ].join(";");
  const encoder = o.enc === "h264_videotoolbox" ? ["-c:v", o.enc, "-b:v", "14M", "-maxrate", "20M", "-profile:v", "high", "-allow_sw", "1"] : ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-profile:v", "high"];
  return {
    added,
    args: [
      "-y", "-hide_banner", "-loglevel", "error", "-threads", "4", "-filter_threads", "2", "-filter_complex_threads", "2",
      "-i", o.clip, "-i", o.opening, "-i", o.verdict, ...(o.middle ? ["-i", o.middle.file] : []),
      "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
      ...encoder, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-t", String(total), o.out,
    ],
  };
}
