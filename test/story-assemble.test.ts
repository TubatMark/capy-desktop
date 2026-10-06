import { describe, expect, it } from "vitest";
import { storyCaptionStyle, storyGraph } from "../src/story/assemble";

describe("storyGraph", () => {
  // title card 2s, page 0 narrates 2..5, page 1 from 5.6..8, page 2 from 8.6..10
  const g = storyGraph([2, 5.6, 8.6], 10, { fade: 0.5, tail: 1.5 });
  it("shows each page until just before the next one's narration, crossfading into it", () => {
    expect(g.offsets).toEqual([5.1, 8.1]); // transitions end exactly when the next page starts speaking
    expect(g.lengths[0]).toBeCloseTo(5.6); // 0 → 5.1, plus the fade overlap
    expect(g.lengths[1]).toBeCloseTo(3.5);
    expect(g.duration).toBeCloseTo(11.5);
  });
  it("builds one zoom per page, one crossfade per join, and places each page's narration at its start", () => {
    expect(g.video.match(/zoompan=/g)).toHaveLength(3);
    expect(g.video.match(/xfade=/g)).toHaveLength(2);
    expect(g.audio).toContain("adelay=delays=2000:all=1");
    expect(g.audio).toContain("adelay=delays=5600:all=1");
    expect(g.audio).toContain("amix=inputs=3:normalize=0");
  });
  it("handles a one-page story (no crossfade)", () => {
    const one = storyGraph([1], 3, { fade: 0.5, tail: 1 });
    expect(one.offsets).toEqual([]);
    expect(one.video).not.toContain("xfade");
    expect(one.duration).toBeCloseTo(4);
  });
});

describe("storyCaptionStyle", () => {
  it("is a rounded, boxed, mixed-case read-along style", () => {
    const s = storyCaptionStyle();
    expect(s.font).toBe("Arial Rounded MT Bold");
    expect(s.uppercase).toBe(false);
    expect(s.box).toBe(true);
    expect(s.highlight).not.toBe(s.primary);
  });
});

import { buildAss } from "../src/ass";
describe("story title card", () => {
  it("keeps the title's case", () => {
    expect(buildAss([], storyCaptionStyle(), { text: "Pip Learns to Share", seconds: 2, keepCase: true })).toContain("Pip Learns to Share");
    expect(buildAss([], storyCaptionStyle(), { text: "Pip", seconds: 2 })).toContain("PIP");
  });
});
