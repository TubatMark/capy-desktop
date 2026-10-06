import { writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "./exec";
import { buildAss, STYLES, styleFor, type HookSpec } from "./ass";
import type { Word } from "./types";
import { vibeById, type Look, type VibeId } from "../lib/look";

export interface RenderOpts {
  /** "center" crops the middle third; "blur" letterboxes over a blurred copy. */
  layout: "center" | "blur";
  style: keyof typeof STYLES | string;
  /** Video encoder. "auto" prefers h264_videotoolbox on macOS, then libx264. */
  encoder: "auto" | "h264_videotoolbox" | "libx264";
  hook?: HookSpec;
  captions: boolean;
  /** Per-video caption/hook styling and colour vibe; omit for the style's defaults. */
  look?: Look;
  /** Cut this window out of the input (seconds from the input's start). Omit to use the whole file. */
  trim?: { start: number; duration: number };
  /** Progress callback with seconds of output encoded so far. */
  onProgress?: (outSec: number) => void;
}

let cachedEncoder: string | null = null;

export async function detectEncoder(pref: RenderOpts["encoder"]): Promise<string> {
  if (pref !== "auto") return pref;
  if (cachedEncoder) return cachedEncoder;
  try {
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-encoders"]);
    if (process.platform === "darwin" && /h264_videotoolbox/.test(stdout)) {
      // verify it actually encodes (fails on some VMs)
      await run("ffmpeg", ["-hide_banner", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1", "-c:v", "h264_videotoolbox", "-f", "null", "-"]);
      cachedEncoder = "h264_videotoolbox";
      return cachedEncoder;
    }
  } catch {
    /* fall through */
  }
  cachedEncoder = "libx264";
  return cachedEncoder;
}

/**
 * ffmpeg filter that turns any aspect into 1080x1920 (lanczos scaling).
 * `sharpen` adds a light unsharp mask when the source has to be enlarged.
 */
export function verticalFilter(layout: RenderOpts["layout"], sharpen = false): string {
  const sharp = sharpen ? ",unsharp=5:5:0.45:3:3:0" : "";
  if (layout === "blur") {
    return [
      "[0:v]split=2[bg][fg]",
      // blur at quarter resolution then upscale: same look, ~4x faster
      "[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:3,scale=1080:1920,eq=brightness=-0.08[bgb]",
      `[fg]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos${sharp}[fgs]`,
      "[bgb][fgs]overlay=(W-w)/2:(H-h)/2",
    ].join(";");
  }
  return `[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920${sharp}`;
}

/** ffmpeg filter snippet for a colour vibe ("" for the original colours). */
export function vibeFilter(id: VibeId): string {
  return vibeById(id).ffmpeg;
}

/** Width, height and frame rate of the first video stream. */
export async function probeVideo(file: string): Promise<{ width: number; height: number; fps: number }> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", file,
  ]);
  const s = JSON.parse(stdout).streams?.[0] ?? {};
  const [num, den] = String(s.r_frame_rate ?? "30/1").split("/").map(Number);
  return { width: s.width ?? 1920, height: s.height ?? 1080, fps: den ? num! / den : 30 };
}

/** How much the source gets enlarged to fill 1080x1920 (>1 means upscaling). */
export function upscaleFactor(src: { width: number; height: number }, layout: RenderOpts["layout"]): number {
  const cover = Math.max(1080 / src.width, 1920 / src.height);
  const fit = Math.min(1080 / src.width, 1920 / src.height);
  return layout === "blur" ? fit : cover;
}

export function escapeFilterPath(p: string): string {
  // ffmpeg filter option escaping: backslash, colon, single quote
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * Render one clip: source segment -> 1080x1920 with burned-in captions.
 * `words` are already rebased to the clip (0 = clip start).
 */
export async function renderClip(
  input: string,
  output: string,
  words: Word[],
  o: RenderOpts,
  assPath = output.replace(/\.mp4$/, ".ass"),
): Promise<void> {
  input = path.resolve(input);
  output = path.resolve(output);
  assPath = path.resolve(assPath);
  const style = styleFor(o.style in STYLES ? (o.style as "bold" | "clean") : "bold", o.look);
  const enc = await detectEncoder(o.encoder);
  const useSubs = o.captions || !!o.hook;
  if (useSubs) await writeFile(assPath, buildAss(o.captions ? words : [], style, o.hook), "utf8");

  const src = await probeVideo(input);
  let filter = verticalFilter(o.layout, upscaleFactor(src, o.layout) > 1.15);
  const vibe = o.look ? vibeFilter(o.look.vibe) : "";
  if (vibe) filter += `,${vibe}`;
  // ffmpeg runs in the .ass folder and references it by bare name: avoids filter-path escaping bugs
  // Named option on purpose: some ffmpeg builds reject the positional form ("No option name near ...").
  if (useSubs) filter += `,ass=filename=${escapeFilterPath(path.basename(assPath))}`;
  if (src.fps > 61) filter += ",fps=60"; // keep 60fps motion, cap anything higher
  filter += ",format=yuv420p[v]";

  const vcodec =
    enc === "h264_videotoolbox"
      ? ["-c:v", "h264_videotoolbox", "-b:v", src.fps > 40 ? "20M" : "14M", "-maxrate", "28M", "-profile:v", "high"]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-profile:v", "high"];

  const trim = o.trim ? ["-ss", o.trim.start.toFixed(3), "-t", o.trim.duration.toFixed(3)] : [];
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:2",
    "-y",
    ...trim,
    "-i",
    input,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "0:a?",
    ...vcodec,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    output,
  ], {
    cwd: path.dirname(assPath),
    onStderr: (s) => {
      const m = s.match(/out_time_us=(\d+)/g);
      if (m && o.onProgress) o.onProgress(Number(m[m.length - 1]!.slice(12)) / 1e6);
    },
  }).catch((e: Error) => {
    if (/No such filter: 'ass'/.test(e.message)) throw new Error(NO_LIBASS);
    throw e;
  });
}

export const NO_LIBASS =
  "This ffmpeg can't burn in captions (built without libass). Fix: brew install ffmpeg-full  (capy finds it automatically)";

/** Grab one 9:16 thumbnail (JPEG) from `input` at `atSec`, cropped like the center layout. `width` sets the output size (height follows 9:16). */
export async function thumbnail(input: string, output: string, atSec: number, layout: RenderOpts["layout"] = "center", width = 360): Promise<void> {
  const w = width;
  const h = Math.round((width * 16) / 9);
  const vf = layout === "blur"
    ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`
    : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", Math.max(0, atSec).toFixed(2), "-i", input, "-frames:v", "1", "-vf", vf, "-q:v", "3", output]);
}

/** Frame from a finished clip (hook still on screen) as a JPEG, for the YouTube thumbnail. */
export async function clipThumbnail(renderedMp4: string, output: string, atSec = 1.4): Promise<void> {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", atSec.toFixed(2), "-i", renderedMp4, "-frames:v", "1", "-q:v", "2", output]);
}
