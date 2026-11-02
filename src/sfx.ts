import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Sound effects laid over an edit. Only CC0 files live in public/sfx (see its manifest.json): uploads go public by
 * themselves, so a sound with unclear rights could cost a claim on a video nobody looked at.
 */

export type SoundId = "whoosh" | "impact" | "riser" | "drone";

/** Brings each file to a level that sits under speech at -14 LUFS (the files' own peaks differ by several dB). */
const GAIN_DB: Record<SoundId, number> = { whoosh: -4, impact: -5, riser: -8, drone: -26 };
const RISER_SECONDS = 2;

export interface Cue {
  file: string;
  /** Seconds into the output. */
  at: number;
  gainDb: number;
  /** Repeat the file under the whole edit, fading out at this time. */
  loopUntil?: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** public/ sits next to the app's worker in a build, and in the working directory otherwise. */
export function soundFile(id: SoundId): string | null {
  const script = process.argv[1];
  const dirs = [path.join(process.cwd(), "public", "sfx"), ...(script ? [path.join(path.dirname(script), "public", "sfx")] : [])];
  for (const dir of dirs) {
    const file = path.join(dir, `${id}.wav`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** A missing file only means a quieter edit: it never stops a render. */
function cues(wanted: { id: SoundId; at: number; loopUntil?: number }[]): Cue[] {
  return wanted.flatMap(({ id, at, loopUntil }) => {
    const file = soundFile(id);
    return file ? [{ file, at: r3(Math.max(0, at)), gainDb: GAIN_DB[id], ...(loopUntil === undefined ? {} : { loopUntil: r3(loopUntil) }) }] : [];
  });
}

/** A Short: a hit as the hook lands, a whoosh as it leaves. */
export function shortCues(seconds: number, hookSeconds?: number): Cue[] {
  return cues([
    { id: "impact", at: 0 },
    ...(hookSeconds !== undefined && hookSeconds + 1 < seconds ? [{ id: "whoosh" as const, at: hookSeconds - 0.2 }] : []),
  ]);
}

/**
 * A narrated Short. The clip's sound, with its own effects, sits low under the host's opening, so the hook's hit and
 * the cuts around the host go on top: a hit under the first words, a whoosh back to the clip, a whoosh to the verdict.
 */
export function commentaryCues(clipSeconds: number, openingSeconds: number): Cue[] {
  const back = openingSeconds + 0.1;
  return cues([
    { id: "impact", at: 0 },
    ...(back + 1 < clipSeconds ? [{ id: "whoosh" as const, at: back }] : []),
    { id: "whoosh", at: clipSeconds },
  ]);
}

/** A long video's section. Moments play with their own sound only. */
export function sectionCues(s: { kind: "teaser" | "card" | "clip"; name: string; seconds: number; lastTeaser?: boolean }): Cue[] {
  if (s.kind === "teaser") {
    return cues([{ id: "whoosh", at: 0 }, ...(s.lastTeaser ? [{ id: "riser" as const, at: s.seconds - RISER_SECONDS }] : [])]);
  }
  if (s.kind === "card") {
    return cues([{ id: s.name === "intro" ? "impact" : "whoosh", at: 0 }, { id: "drone", at: 0, loopUntil: s.seconds }]);
  }
  return [];
}

/** ffmpeg inputs for the cues, to go after the edit's other inputs. */
export const cueInputs = (list: Cue[]): string[] => list.flatMap((c) => [...(c.loopUntil === undefined ? [] : ["-stream_loop", "-1"]), "-i", c.file]);

/** Filter that lays the cues over `input`, whose length it keeps. `first` is the ffmpeg index of the first cue input. */
export function mixCues(input: string, output: string, list: Cue[], first: number): string {
  const stereo = "aresample=48000,aformat=channel_layouts=stereo";
  const parts = list.map((c, i) => {
    const bed = c.loopUntil === undefined ? "" : `,atrim=0:${c.loopUntil},afade=t=in:st=0:d=0.25,afade=t=out:st=${r3(Math.max(0, c.loopUntil - 0.25))}:d=0.25`;
    return `[${first + i}:a]${stereo}${bed},volume=${c.gainDb}dB,adelay=delays=${Math.round(c.at * 1000)}:all=1[sfx${i}]`;
  });
  const labels = list.map((_, i) => `[sfx${i}]`).join("");
  return [
    `[${input}]${stereo}[sfxmain]`,
    ...parts,
    // level=disabled: the limiter only catches peaks and doesn't raise the whole mix
    `[sfxmain]${labels}amix=inputs=${list.length + 1}:normalize=0:duration=first,alimiter=limit=0.89:level=disabled[${output}]`,
  ].join(";");
}
