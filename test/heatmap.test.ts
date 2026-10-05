import { describe, expect, it } from "vitest";
import { fmtPeaks, peakFor, replayPeaks } from "../src/heatmap";

const h = (vals: number[], step = 10) => vals.map((value, i) => ({ start: i * step, end: (i + 1) * step, value }));

describe("replayPeaks", () => {
  it("returns [] for missing or empty heatmaps", () => {
    expect(replayPeaks(undefined)).toEqual([]);
    expect(replayPeaks([])).toEqual([]);
  });
  it("merges adjacent buckets above the threshold and keeps the max value", () => {
    const p = replayPeaks(h([0.1, 0.6, 0.9, 0.2, 0.55, 0.1]));
    expect(p).toEqual([
      { start: 10, end: 30, value: 0.9 },
      { start: 40, end: 50, value: 0.55 },
    ]);
  });
  it("sorts by value and caps the count", () => {
    const p = replayPeaks(h([0.6, 0, 0.8, 0, 0.7, 0, 0.9]), { max: 2 });
    expect(p.map((x) => x.value)).toEqual([0.9, 0.8]);
  });
  it("splits runs longer than maxLen so a flat popular video doesn't become one giant peak", () => {
    const p = replayPeaks(h(Array(30).fill(0.8)), { maxLen: 90, max: 20 });
    expect(p.every((x) => x.end - x.start <= 90)).toBe(true);
    expect(p.length).toBeGreaterThan(1);
  });
});

describe("peakFor / fmtPeaks", () => {
  const peaks = [{ start: 100, end: 130, value: 1 }, { start: 300, end: 310, value: 0.6 }];
  it("returns the highest overlapping peak value", () => {
    expect(peakFor(peaks, 120, 160)).toBe(1);
    expect(peakFor(peaks, 200, 250)).toBeUndefined();
  });
  it("formats mm:ss ranges with percent", () => {
    expect(fmtPeaks(peaks)).toBe("1:40–2:10 (100%)\n5:00–5:10 (60%)");
  });
});
