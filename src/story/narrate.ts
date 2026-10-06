import { run } from "../exec";
import { spreadWords } from "../translate";
import type { Word } from "../types";

/**
 * Narration with the voices built into macOS (`say`): free, offline, and any better voice the user installs in
 * System Settings → Accessibility → Spoken Content shows up here too.
 */

export interface Voice {
  name: string;
  lang: string;
}

/** Sound-effect voices that make no sense for a bedtime story. */
const NOVELTY = new Set(["Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox"]);

const rank = (v: Voice) => (/\(Premium\)/.test(v.name) ? 0 : /\(Enhanced\)/.test(v.name) ? 1 : v.name === "Samantha" ? 2 : v.lang === "en_US" ? 3 : 4);

/** English storytelling voices from `say -v ?`, best first. */
export function parseVoices(out: string): Voice[] {
  const voices: Voice[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(.+?)\s+(en_[A-Z]{2})\s+#/);
    if (m && !NOVELTY.has(m[1]!.trim())) voices.push({ name: m[1]!.trim(), lang: m[2]! });
  }
  return voices.sort((a, b) => rank(a) - rank(b));
}

export async function listVoices(): Promise<Voice[]> {
  const { stdout } = await run("say", ["-v", "?"]);
  return parseVoices(stdout);
}

export const DEFAULT_VOICE = "Samantha";
/** Words per minute: a little slower than conversation, for small listeners. */
const RATE = 165;

/** Speak one page into `out` (AIFF) and return its length in seconds. */
export async function narrate(text: string, voice: string, out: string): Promise<number> {
  await run("say", ["-v", voice, "-r", String(RATE), "-o", out, "--", text]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("The narration came out empty");
  return d;
}

/**
 * Pages end to end with a pause between them, after an optional title-card lead-in. Each page's words are timed
 * across its narration by length (close enough for a read-along highlight).
 */
export function storyTimeline(pages: { text: string; duration: number }[], gap = 0.6, lead = 0): { words: Word[]; starts: number[]; total: number } {
  const words: Word[] = [];
  const starts: number[] = [];
  let t = lead;
  pages.forEach((p, i) => {
    starts.push(t);
    words.push(...spreadWords({ i, start: t, end: t + p.duration, text: p.text }, p.text));
    t += p.duration + (i < pages.length - 1 ? gap : 0);
  });
  return { words, starts, total: Math.round(t * 1000) / 1000 };
}
