import { describe, expect, it } from "vitest";
import { parseVoices, storyTimeline } from "../src/story/narrate";

describe("parseVoices", () => {
  const out = `Albert              en_US    # Hello! My name is Albert.
Ava (Premium)       en_US    # Hello! My name is Ava.
Bubbles             en_US    # Hello! My name is Bubbles.
Daniel              en_GB    # Hello! My name is Daniel.
Eddy (English (US)) en_US    # Hello! My name is Eddy.
Samantha            en_US    # Hello! My name is Samantha.
Thomas              fr_FR    # Bonjour, je m’appelle Thomas.`;
  it("keeps natural English voices, best first, and drops the novelty ones", () => {
    expect(parseVoices(out)).toEqual([
      { name: "Ava (Premium)", lang: "en_US" },
      { name: "Samantha", lang: "en_US" },
      { name: "Eddy (English (US))", lang: "en_US" },
      { name: "Daniel", lang: "en_GB" },
    ]);
  });
});

describe("storyTimeline", () => {
  it("lays pages end to end with a pause between them and times every word inside its page", () => {
    const t = storyTimeline([{ text: "Pip had a sled.", duration: 2 }, { text: "He loved it.", duration: 1.5 }], 0.5);
    expect(t.starts).toEqual([0, 2.5]);
    expect(t.total).toBe(4);
    expect(t.words.map((w) => w.text)).toEqual(["Pip", "had", "a", "sled.", "He", "loved", "it."]);
    expect(t.words[0]!.start).toBe(0);
    expect(t.words[3]!.end).toBeCloseTo(2);
    expect(t.words[4]!.start).toBeCloseTo(2.5);
    expect(t.words.at(-1)!.end).toBeCloseTo(4);
  });
  it("starts the narration after a title card lead-in", () => {
    const t = storyTimeline([{ text: "Hi.", duration: 1 }], 0.5, 2);
    expect(t.starts).toEqual([2]);
    expect(t.total).toBe(3);
  });
});
