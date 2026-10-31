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
  opening: z.string().describe("Spoken over the first seconds, 6-12 words: your opinion or a question that makes people watch. Never a description of what's on screen"),
  verdict: z.string().describe("Spoken after the clip, 8-16 words: your verdict, with a reason, ending by asking what the viewer thinks"),
});
export type ShortCommentary = z.infer<typeof Schema>;

export function commentaryPrompt(o: { creator: string; title: string; reason?: string; excerpt: string }): string {
  return `You are the host of a clips channel, adding your own take to this moment from ${o.creator}'s stream.

Moment: "${o.title}"
Why it stood out: ${o.reason ?? "n/a"}
What is said: ${o.excerpt}

Write what the host says. Give a real opinion that a viewer can agree or argue with. YouTube doesn't count a voice-over that describes the screen as original, so never narrate what's happening.
- Say only what the clip supports. Don't invent facts, motives or background about real people, and don't state what someone privately feels as fact.
- Don't spoil the punchline in the opening.
- Sound like a person talking: short, plain, no hype words like "insane" or "you won't believe".`;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export async function writeCommentary(o: Parameters<typeof commentaryPrompt>[0], ai: AiOpts): Promise<ShortCommentary> {
  const res = await askAgent(ai.agent, commentaryPrompt(o), {
    task: "metadata",
    model: ai.model,
    maxTurns: 2,
    effort: "low",
    system: "You write short spoken commentary for a clips channel. Answer only with the requested JSON.",
    schema: strip(z.toJSONSchema(Schema, { target: "draft-7" }) as Record<string, unknown>),
  });
  const out = Schema.parse(res.data);
  // a long opening talks over too much of the clip
  if (words(out.opening) > 18 || words(out.verdict) > 26) throw new Error("The commentary came out too long");
  return { opening: out.opening.trim(), verdict: out.verdict.trim() };
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

export function commentaryAss(o: { opening: string; openingEnd: number; verdict: string; outroStart: number; outroEnd: number }): string {
  return (
    HEADER +
    line("Take", 0.1, o.openingEnd, 620, o.opening) +
    line("Verdict", o.outroStart + 0.1, o.outroEnd, 860, o.verdict)
  );
}

const LUFS = "loudnorm=I=-14:TP=-1.5:LRA=11";
/** Time after the verdict before the Short ends. */
const OUTRO_TAIL = 0.6;
/** The clip's own sound under the host. */
const DUCK = 0.16;

export const outroLength = (verdictSeconds: number) => r3(verdictSeconds + OUTRO_TAIL);
/** ffmpeg arguments: runs in the captions file's folder and names that file bare. */
export function commentaryArgs(o: {
  clip: string;
  clipSeconds: number;
  opening: string;
  openingSeconds: number;
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
    `[clipa]aresample=48000,volume=${DUCK}:enable='lt(t,${hold})'[cliplow]`,
    `[1:a]aresample=48000,${LUFS},aresample=48000,adelay=delays=100:all=1,apad=whole_dur=${r3(o.clipSeconds)}[take]`,
    `[cliplow][take]amix=inputs=2:normalize=0:duration=first,atrim=0:${r3(o.clipSeconds)},asetpts=PTS-STARTPTS[front]`,
    `[taila0]atrim=start=${from},asetpts=PTS-STARTPTS,aresample=48000,volume=${DUCK},apad=whole_dur=${added},atrim=0:${added}[low]`,
    `[2:a]aresample=48000,${LUFS},aresample=48000,apad=whole_dur=${added},atrim=0:${added}[say]`,
    `[low][say]amix=inputs=2:normalize=0:duration=first[back]`,
    `[front][back]concat=n=2:v=0:a=1,afade=t=out:st=${r3(total - 0.25)}:d=0.25[a]`,
  ].join(";");
  const encoder = o.enc === "h264_videotoolbox" ? ["-c:v", o.enc, "-b:v", "14M", "-maxrate", "20M", "-profile:v", "high", "-allow_sw", "1"] : ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-profile:v", "high"];
  return {
    added,
    args: [
      "-y", "-hide_banner", "-loglevel", "error", "-threads", "4", "-filter_threads", "2", "-filter_complex_threads", "2",
      "-i", o.clip, "-i", o.opening, "-i", o.verdict,
      "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
      ...encoder, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-t", String(total), o.out,
    ],
  };
}
