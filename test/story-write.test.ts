import { describe, expect, it } from "vitest";
import { normalizeStory, normalizeStoryReview, storyWriterPrompt } from "../src/story/write";
import type { StorySeries } from "../lib/types";

const series: StorySeries = {
  id: "s1", title: "Pip & Lulu", ageBand: "2-4", tone: "gentle and funny", values: ["sharing"], artStyle: "flat storybook vector",
  characters: [
    { id: "pip", name: "Pip", description: "a small penguin with an orange scarf", status: "ready" },
    { id: "lulu", name: "Lulu", description: "a fluffy white seal pup", status: "ready" },
  ],
  createdAt: 0, updatedAt: 0,
};

describe("storyWriterPrompt", () => {
  it("carries the cast, the age band's rules and the brief", () => {
    const p = storyWriterPrompt(series, "Pip learns to share his sled");
    expect(p).toContain("Pip (id: pip)");
    expect(p).toContain("Lulu (id: lulu)");
    expect(p).toMatch(/ages 2-4/i);
    expect(p).toContain("Pip learns to share his sled");
  });
});

describe("normalizeStory", () => {
  const page = (cast: { id: string; x?: number }[], text = "Pip slid down the hill.") => ({ text, scene: "a snowy hill", cast, mood: "happy" });
  it("keeps only real cast members, at most 3 a page, spreading missing positions", () => {
    const s = normalizeStory({ title: " Pip ", moral: "Sharing is fun", pages: [page([{ id: "pip" }, { id: "lulu" }, { id: "ghost", x: 0.5 }]), page([{ id: "pip", x: 0.3 }])] }, series);
    expect(s.title).toBe("Pip");
    expect(s.pages[0]!.cast.map((c) => c.id)).toEqual(["pip", "lulu"]);
    expect(s.pages[0]!.cast.map((c) => c.x)).toEqual([0.33, 0.67]);
    expect(s.pages[1]!.cast[0]!.x).toBe(0.3);
    expect(s.pages.every((p) => p.status === "pending")).toBe(true);
  });
  it("caps the length at 12 pages and drops empty pages", () => {
    const s = normalizeStory({ title: "T", moral: "M", pages: [...Array.from({ length: 15 }, () => page([])), { text: " ", scene: "x", cast: [] }] }, series);
    expect(s.pages).toHaveLength(12);
  });
  it("fails clearly when the AI wrote no pages", () => {
    expect(() => normalizeStory({ title: "T", moral: "M", pages: [] }, series)).toThrow(/no pages/i);
  });
});

describe("normalizeStoryReview", () => {
  it("defaults an unknown verdict to fix and keeps short notes", () => {
    expect(normalizeStoryReview({ verdict: "meh", notes: ["Page 3 is scary", 5, "x".repeat(500)] })).toEqual({ verdict: "fix", notes: ["Page 3 is scary", "x".repeat(300)] });
    expect(normalizeStoryReview({ verdict: "ok", notes: [] })).toEqual({ verdict: "ok", notes: [] });
  });
});
