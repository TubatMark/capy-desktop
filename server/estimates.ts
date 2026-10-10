import { fence } from "./worker/context";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { OUTPUT_ROOT } from "./paths";

/**
 * Learned timings for this machine, so the UI can show "~40s remaining".
 * Each key stores an exponential moving average of a rate (seconds per unit).
 */
export interface Timings {
  metaSec: number;
  /** Seconds per minute of source video (caption fetch is mostly flat, so per-minute is small). */
  captionsSecPerMin: number;
  captionsFlatSec: number;
  /** Seconds per 1k transcript words for the Claude call. */
  pickSecPerKWords: number;
  pickFlatSec: number;
  /** Seconds per second of segment downloaded (includes yt-dlp's re-encode). */
  segmentSecPerSec: number;
  /** Seconds per second of clip rendered. */
  renderSecPerSec: number;
  /** Seconds of transcription per minute of audio (Whisper fallback). */
  whisperSecPerMin: number;
}

export const DEFAULT_TIMINGS: Timings = {
  metaSec: 12,
  captionsSecPerMin: 0.4,
  captionsFlatSec: 8,
  pickSecPerKWords: 2,
  pickFlatSec: 6,
  segmentSecPerSec: 0.35,
  renderSecPerSec: 0.3,
  whisperSecPerMin: 12,
};

const FILE = path.join(OUTPUT_ROOT, ".timings.json");
let cache: Timings | null = null;

export async function loadTimings(): Promise<Timings> {
  if (cache) return cache;
  try {
    cache = { ...DEFAULT_TIMINGS, ...JSON.parse(await readFile(FILE, "utf8")) };
  } catch {
    cache = { ...DEFAULT_TIMINGS };
  }
  return cache!;
}

/** Blend an observed value into a timing (EMA, alpha 0.4). */
export async function learn(key: keyof Timings, observed: number) {
  if (!Number.isFinite(observed) || observed <= 0) return;
  const t = await loadTimings();
  t[key] = t[key] * 0.6 + observed * 0.4;
  cache = t;
  try {
    fence(() => {
      mkdirSync(OUTPUT_ROOT, { recursive: true });
      writeFileSync(FILE, JSON.stringify(t, null, 2));
    });
  } catch {
    /* best effort */
  }
}
