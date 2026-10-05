import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/pick";

const meta = { title: "Ep 1", duration: 3600, channel: "Mia" };
const base = { count: 6, minSec: 20, maxSec: 60 };

describe("buildPrompt", () => {
  it("has no peaks section without peaks, and keeps the speakers' language for original", () => {
    const p = buildPrompt("[0] hi", meta, { ...base, audience: "original" });
    expect(p).not.toContain("Viewer replay peaks");
    expect(p).toContain("same language the speakers use");
  });
  it("adds the replay peaks section", () => {
    const p = buildPrompt("[0] hi", meta, { ...base, peaks: [{ start: 100, end: 130, value: 1 }] });
    expect(p).toContain("Viewer replay peaks");
    expect(p).toContain("1:40–2:10 (100%)");
  });
  it("switches text to US English for en-us", () => {
    const p = buildPrompt("[0] hi", meta, { ...base, audience: "en-us" });
    expect(p).toContain("natural US English");
    expect(p).not.toContain("same language the speakers use");
  });
  it("adds the replace section with the rejection reason and ranges to avoid", () => {
    const p = buildPrompt("[0] hi", meta, { ...base, count: 1, replace: { start: 190, end: 230, reason: "ends before the payoff", avoid: [{ start: 10, end: 40 }] } });
    expect(p).toContain("3:10–3:50 was rejected because: ends before the payoff");
    expect(p).toContain("0:10–0:40");
  });
});
