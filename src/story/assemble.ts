import { writeFile } from "node:fs/promises";
import { buildAss, STYLES, type CaptionStyle } from "../ass";
import { run } from "../exec";
import { detectEncoder, escapeFilterPath } from "../render";
import path from "node:path";
import type { Word } from "../types";

/**
 * A story video: every page illustration with a slow zoom, crossfading into the next page just before its
 * narration starts; the narration laid on the timeline; read-along captions burned in; the title over the first page.
 */

const FPS = 30;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Read-along captions: rounded, mixed case, on a soft box so they read over any illustration. */
export function storyCaptionStyle(): CaptionStyle {
  return {
    ...STYLES.clean!,
    font: "Arial Rounded MT Bold",
    size: 66,
    primary: "&H00FFFFFF",
    highlight: "&H0000E5FF",
    outline: "&H00203A2A",
    outlineWidth: 4,
    marginV: 190,
    groupWords: 5,
    groupSec: 3,
    groupChars: 24,
    uppercase: false,
    box: true,
    hookSize: 88,
    hookPrimary: "&H00FFFFFF",
    hookBack: "&H50203A2A",
    hookMarginV: 260,
  };
}

/**
 * Filter graphs for N pages. `starts[i]` is when page i's narration begins (page 0's after the title lead-in);
 * the picture changes `fade` seconds before that, so the crossfade ends as the voice starts.
 */
export function storyGraph(starts: number[], total: number, o: { fade?: number; tail?: number } = {}) {
  const fade = o.fade ?? 0.5;
  const end = total + (o.tail ?? 1.2);
  const bounds = starts.map((s, i) => (i === 0 ? 0 : r3(s - fade)));
  const lengths = bounds.map((b, i) => r3(i < bounds.length - 1 ? bounds[i + 1]! - b + fade : end - b));
  const offsets = bounds.slice(1);

  const video: string[] = [];
  lengths.forEach((len, i) => {
    const frames = Math.max(1, Math.round(len * FPS));
    // alternate a gentle zoom in and a gentle zoom out so consecutive pages don't feel identical
    const z = i % 2 === 0 ? `min(1+0.10*on/${frames},1.10)` : `max(1.10-0.10*on/${frames},1)`;
    video.push(
      `[${i}:v]scale=2160:3840:flags=lanczos,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=${FPS},setsar=1,format=yuv420p[p${i}]`,
    );
  });
  let last = "p0";
  offsets.forEach((off, k) => {
    const out = `x${k + 1}`;
    video.push(`[${last}][p${k + 1}]xfade=transition=fade:duration=${fade}:offset=${off}[${out}]`);
    last = out;
  });

  const n = starts.length;
  const audio = [
    ...starts.map((s, i) => `[${n + i}:a]aresample=48000,adelay=delays=${Math.round(s * 1000)}:all=1[a${i}]`),
    `${starts.map((_, i) => `[a${i}]`).join("")}amix=inputs=${n}:normalize=0,apad,atrim=0:${r3(end)}[aout]`,
  ].join(";");

  return { lengths, offsets, duration: r3(end), video: video.join(";"), lastVideo: last, audio };
}

export interface AssembleInput {
  pages: string[];
  narration: string[];
  starts: number[];
  total: number;
  assFile: string;
  out: string;
}

/**
 * The ffmpeg command for a story. It runs in the captions file's folder and names that file bare, so no folder
 * name (an apostrophe, a colon) has to survive filter-string escaping; inputs and output are plain arguments.
 */
export function assembleArgs(o: AssembleInput, enc: string): { args: string[]; cwd: string; duration: number } {
  const g = storyGraph(o.starts, o.total);
  const filter = `${g.video};[${g.lastVideo}]ass=filename=${escapeFilterPath(path.basename(o.assFile))}[vout];${g.audio}`;
  const encArgs = enc === "h264_videotoolbox" ? ["-c:v", enc, "-b:v", "8M", "-allow_sw", "1"] : ["-c:v", "libx264", "-preset", "medium", "-crf", "19"];
  const args = [
    "-y",
    "-hide_banner",
    ...o.pages.flatMap((p) => ["-i", p]),
    ...o.narration.flatMap((a) => ["-i", a]),
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...encArgs,
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-t",
    String(g.duration),
    "-movflags",
    "+faststart",
    o.out,
  ];
  return { args, cwd: path.dirname(o.assFile), duration: g.duration };
}

/** Render the story to `out` (mp4). Pages are PNGs, narration one AIFF per page. */
export async function assembleStory(o: AssembleInput & { words: Word[]; title: string; lead: number }): Promise<{ duration: number }> {
  await writeFile(o.assFile, buildAss(o.words, storyCaptionStyle(), { text: o.title, seconds: o.lead, keepCase: true }));
  const { args, cwd, duration } = assembleArgs(o, await detectEncoder("auto"));
  await run("ffmpeg", args, { cwd });
  return { duration };
}
