import { createReadStream, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { run } from "./exec";
import { replayPeaks, type HeatPoint } from "./heatmap";

/**
 * Where live chat went off during a stream: what viewers reacted to at the time, which the transcript can't show. Read
 * from yt-dlp's chat replay, a line at a time, since a long stream's file runs to tens of MB.
 */
const BUCKET_SEC = 20;
const OFFSET = /"videoOffsetTimeMsec":\s*"(\d+)"/;

export function bucketChat(offsetsMs: number[]): HeatPoint[] {
  const counts = new Map<number, number>();
  for (const ms of offsetsMs) {
    const b = Math.floor(ms / 1000 / BUCKET_SEC);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  if (counts.size < 10) return [];
  // relative to a busy moment, not the single wildest: one spam burst shouldn't flatten everything else
  const sorted = [...counts.values()].sort((a, b) => a - b);
  const busy = sorted[Math.floor(sorted.length * 0.98)]!;
  if (busy < 5) return [];
  return [...counts].map(([b, n]) => ({ start: b * BUCKET_SEC, end: (b + 1) * BUCKET_SEC, value: Math.min(1, n / busy) }));
}

export const chatPeaks = (points: HeatPoint[]) => replayPeaks(points, { minValue: 0.8, max: 8, maxLen: 80 });

export async function readChatFile(file: string): Promise<HeatPoint[]> {
  const offsets: number[] = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const m = OFFSET.exec(line);
    if (m) offsets.push(Number(m[1]));
  }
  return bucketChat(offsets);
}

/** Time-boxed, and never fatal: chat is extra evidence, and many videos have none. */
export async function fetchChatPeaks(url: string, workDir: string, common: string[]): Promise<HeatPoint[]> {
  const base = path.join(workDir, "chat");
  const file = `${base}.live_chat.json`;
  try {
    await run("yt-dlp", [...common, "--skip-download", "--write-subs", "--sub-langs", "live_chat", "--sub-format", "json", "-o", base, url], { timeoutMs: 240_000 }).catch(() => undefined);
    const found = existsSync(file) ? file : existsSync(`${file}.part`) ? `${file}.part` : undefined;
    if (!found) return [];
    return chatPeaks(await readChatFile(found));
  } catch {
    return [];
  } finally {
    await rm(file, { force: true }).catch(() => {});
    await rm(`${file}.part`, { force: true }).catch(() => {});
  }
}
