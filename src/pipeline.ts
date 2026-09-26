import { mkdir, readFile, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { fetchAudio, fetchCaptions, fetchMeta, fetchSection, videoIdFromUrl, type YtOpts } from "./youtube";
import { wordsInRange } from "./captions";
import { pickClips, type PickOpts } from "./pick";
import { renderClip, thumbnail, clipThumbnail, type RenderOpts } from "./render";
import { transcribe } from "./transcribe";
import { pad2, slug } from "./util";
import type { Clip, VideoMeta, Word } from "./types";

/** Seconds of extra footage downloaded on each side of a pick so edits don't need a re-download. */
export const SEGMENT_PAD = 15;

export interface Segment {
  start: number;
  end: number;
  file: string;
}

export async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Fetch metadata (or reuse a cached meta.json under outRoot for the same video id). */
export async function stageMeta(url: string, outRoot: string, yt: YtOpts): Promise<{ meta: VideoMeta; jobDir: string; cached: boolean }> {
  const id = videoIdFromUrl(url);
  if (!id) throw new Error(`Not a YouTube URL: ${url}`);
  const { readdir } = await import("node:fs/promises");
  try {
    const hit = (await readdir(outRoot)).find((d) => d.endsWith(`-${id}`));
    if (hit && (await exists(path.join(outRoot, hit, "meta.json")))) {
      const jobDir = path.join(outRoot, hit);
      return { meta: JSON.parse(await readFile(path.join(jobDir, "meta.json"), "utf8")), jobDir, cached: true };
    }
  } catch {
    /* no output dir yet */
  }
  const meta = await fetchMeta(url, yt);
  const jobDir = path.join(outRoot, `${slug(meta.title, 48)}-${meta.id}`);
  await mkdir(path.join(jobDir, "work"), { recursive: true });
  await writeFile(path.join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  return { meta, jobDir, cached: false };
}

/** Word-level transcript: cached words.json, else YouTube captions, else local Whisper. */
export async function stageWords(
  url: string,
  jobDir: string,
  meta: VideoMeta,
  yt: YtOpts,
  o: { lang?: string; forceWhisper?: boolean; log?: (m: string) => void } = {},
): Promise<{ words: Word[]; source: "cache" | "captions" | "whisper" }> {
  const wordsFile = path.join(jobDir, "words.json");
  const workDir = path.join(jobDir, "work");
  await mkdir(workDir, { recursive: true });
  if ((await exists(wordsFile)) && !o.forceWhisper && !o.lang) {
    return { words: JSON.parse(await readFile(wordsFile, "utf8")), source: "cache" };
  }
  let words: Word[] | null = null;
  let source: "captions" | "whisper" = "captions";
  let captionErr: string | undefined;
  if (!o.forceWhisper) {
    try {
      words = await fetchCaptions(url, workDir, o.lang, yt, meta);
      if (!words) o.log?.("this video has no captions");
    } catch (e) {
      captionErr = (e instanceof Error ? e.message : String(e)).split("\n").filter(Boolean).pop();
      o.log?.(`caption download failed: ${captionErr}`);
    }
  }
  if (!words) {
    try {
      o.log?.("downloading audio for local transcription");
      const audio = await fetchAudio(url, path.join(workDir, "audio.m4a"), yt);
      o.log?.("transcribing locally (the slow part)");
      words = await transcribe(audio, workDir, { language: o.lang });
      source = "whisper";
    } catch (e) {
      const hint = captionErr ? `YouTube captions failed (${captionErr}). Try cookies from your browser, or wait a few minutes.\n` : "";
      throw new Error(hint + (e instanceof Error ? e.message : String(e)));
    }
  }
  if (words.length < 30) throw new Error("Transcript is too short to clip from.");
  await writeFile(wordsFile, JSON.stringify(words));
  return { words, source };
}

export async function stagePick(words: Word[], meta: VideoMeta, o: PickOpts) {
  return pickClips(words, meta, o);
}

/** Padded segment bounds for a clip. */
export function segmentFor(clip: { start: number; end: number }, duration: number): { start: number; end: number } {
  return { start: Math.max(0, clip.start - SEGMENT_PAD), end: Math.min(duration || clip.end + SEGMENT_PAD, clip.end + SEGMENT_PAD) };
}

export function segmentName(n: number, seg: { start: number; end: number }, maxRes: number) {
  return `${pad2(n)}-${Math.round(seg.start * 10)}-${Math.round(seg.end * 10)}-${maxRes}p.src.mp4`;
}

/** Download the padded segment for a clip (skipped if present) and make its thumbnail. */
export async function stageSegment(
  url: string,
  jobDir: string,
  n: number,
  clip: { start: number; end: number },
  duration: number,
  yt: YtOpts,
  maxRes: number,
): Promise<Segment & { thumb: string }> {
  const workDir = path.join(jobDir, "work");
  const seg = segmentFor(clip, duration);
  const file = path.join(workDir, segmentName(n, seg, maxRes));
  if (!(await exists(file))) {
    await rm(`${file}.part`, { force: true });
    await fetchSection(url, seg.start, seg.end, file, yt, maxRes);
  }
  const thumb = path.join(workDir, `${pad2(n)}.jpg`);
  try {
    await thumbnail(file, thumb, clip.start - seg.start + Math.min(1, (clip.end - clip.start) / 2));
  } catch {
    // e.g. the segment is shorter than expected; use the first frame instead
    await thumbnail(file, thumb, 0);
  }
  return { ...seg, file, thumb };
}

/** Render one clip from its padded segment. */
export async function stageRender(
  jobDir: string,
  n: number,
  clip: Clip,
  seg: Segment,
  words: Word[],
  o: Pick<RenderOpts, "layout" | "style" | "captions" | "onProgress"> & { hook: boolean },
): Promise<string> {
  const out = path.join(jobDir, `${pad2(n)}-${slug(clip.title)}.mp4`);
  await renderClip(
    seg.file,
    out,
    wordsInRange(words, clip.start, clip.end),
    {
      layout: o.layout,
      style: o.style,
      encoder: "auto",
      captions: o.captions,
      hook: o.hook && clip.hook ? { text: clip.hook, seconds: Math.min(3, clip.end - clip.start) } : undefined,
      trim: { start: clip.start - seg.start, duration: clip.end - clip.start },
      onProgress: o.onProgress,
    },
    path.join(jobDir, "work", `${pad2(n)}.ass`),
  );
  await writePublishFiles(out, clip);
  return out;
}

/** Next to NN-title.mp4, write NN-title.jpg (thumbnail) and NN-title.txt (title/description/hashtags to paste into YouTube). */
export async function writePublishFiles(renderedMp4: string, clip: Clip): Promise<{ thumb: string; text: string }> {
  const base = renderedMp4.replace(/\.mp4$/, "");
  const thumb = `${base}.jpg`;
  const text = `${base}.txt`;
  try {
    await clipThumbnail(renderedMp4, thumb);
  } catch {
    await clipThumbnail(renderedMp4, thumb, 0.2);
  }
  const tags = (clip.hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  await writeFile(
    text,
    [`TITLE`, clip.ytTitle ?? clip.title, ``, `DESCRIPTION`, clip.description ?? "", ``, `HASHTAGS`, tags, ``].join("\n"),
    "utf8",
  );
  return { thumb, text };
}
