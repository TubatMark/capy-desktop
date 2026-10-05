/** One bucket of YouTube's "Most replayed" graph (yt-dlp `heatmap`), value 0..1. */
export interface HeatPoint {
  start: number;
  end: number;
  value: number;
}

/** Merge adjacent buckets at or above `minValue` into ranges (split past `maxLen` s), strongest first. */
export function replayPeaks(heat: HeatPoint[] | undefined, o: { minValue?: number; max?: number; maxLen?: number } = {}): HeatPoint[] {
  const { minValue = 0.5, max = 8, maxLen = 90 } = o;
  const out: HeatPoint[] = [];
  let cur: HeatPoint | null = null;
  for (const p of [...(heat ?? [])].sort((a, b) => a.start - b.start)) {
    const hot = p.value >= minValue;
    if (hot && cur && p.start - cur.end < 0.5 && p.end - cur.start <= maxLen) {
      cur.end = p.end;
      cur.value = Math.max(cur.value, p.value);
      continue;
    }
    if (cur) out.push(cur);
    cur = hot ? { ...p } : null;
  }
  if (cur) out.push(cur);
  return out.sort((a, b) => b.value - a.value).slice(0, max);
}

/** Highest peak value overlapping [start, end), if any. */
export function peakFor(peaks: HeatPoint[], start: number, end: number): number | undefined {
  let best: number | undefined;
  for (const p of peaks) if (p.start < end && p.end > start) best = Math.max(best ?? 0, p.value);
  return best;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** One line per peak, e.g. "12:40–13:10 (100%)", for the picker prompt. */
export function fmtPeaks(peaks: HeatPoint[]): string {
  return peaks.map((p) => `${mmss(p.start)}–${mmss(p.end)} (${Math.round(p.value * 100)}%)`).join("\n");
}
