import { describe, expect, it } from "vitest";
import { applyTranslations, mergeWords, splitPhrases, spreadWords } from "../src/translate";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("splitPhrases", () => {
  it("cuts at sentence punctuation", () => {
    const p = splitPhrases([w("Oi,", 0, 0.3), w("tudo", 0.3, 0.6), w("bem?", 0.6, 1), w("Sim.", 1.1, 1.5)], 0, 10);
    expect(p.map((x) => x.text)).toEqual(["Oi, tudo bem?", "Sim."]);
    expect(p[0]).toMatchObject({ i: 0, start: 0, end: 1 });
  });
  it("cuts at gaps over 0.6s and at 4s", () => {
    const long = Array.from({ length: 12 }, (_, k) => w(`w${k}`, 2 + k * 0.5, 2 + k * 0.5 + 0.4));
    const p = splitPhrases([w("a", 0, 0.2), w("b", 1, 1.2), ...long], 0, 20);
    expect(p[0]!.text).toBe("a");
    expect(p.every((x) => x.end - x.start <= 4.01)).toBe(true);
  });
  it("only uses words starting inside the range", () => {
    expect(splitPhrases([w("x", 0, 1), w("y.", 5, 6)], 4, 10).map((x) => x.text)).toEqual(["y."]);
  });
});

describe("spreadWords", () => {
  it("spreads words over the phrase by length, ordered and inside the span", () => {
    const out = spreadWords({ i: 0, start: 10, end: 12, text: "x" }, "I can't believe it");
    expect(out.map((x) => x.text)).toEqual(["I", "can't", "believe", "it"]);
    expect(out[0]!.start).toBe(10);
    expect(out.at(-1)!.end).toBeCloseTo(12);
    for (let k = 1; k < out.length; k++) expect(out[k]!.start).toBeGreaterThanOrEqual(out[k - 1]!.end - 1e-9);
  });
  it("stretches a too-short phrase toward the next phrase so words keep 0.12s", () => {
    const out = spreadWords({ i: 0, start: 5, end: 5.2, text: "x" }, "one two three four", 6);
    expect(out.every((x) => x.end - x.start >= 0.12 - 1e-9)).toBe(true);
    expect(out.at(-1)!.end).toBeLessThanOrEqual(6);
  });
  it("never runs past the next phrase even when it is too close for 0.12s per word", () => {
    const out = spreadWords({ i: 0, start: 5, end: 5.1, text: "x" }, "one two three four five", 5.3);
    expect(out.at(-1)!.end).toBeLessThanOrEqual(5.3);
    for (let k = 0; k < out.length; k++) expect(out[k]!.end).toBeGreaterThan(out[k]!.start);
  });
});

describe("applyTranslations", () => {
  const phrases = [{ i: 0, start: 0, end: 1, text: "Oi." }, { i: 1, start: 1, end: 2, text: "Tchau." }];
  it("keeps the original text for missing or empty translations", () => {
    const out = applyTranslations(phrases, [{ i: 0, en: "Hi." }, { i: 1, en: "  " }, { i: 7, en: "junk" }]);
    expect(out.map((x) => x.text)).toEqual(["Hi.", "Tchau."]);
  });
});

describe("mergeWords", () => {
  it("replaces words inside the range and keeps the rest sorted", () => {
    const out = mergeWords([w("a", 0, 1), w("b", 5, 6), w("c", 20, 21)], [w("B", 5, 5.5), w("B2", 5.5, 6)], { start: 4, end: 10 });
    expect(out.map((x) => x.text)).toEqual(["a", "B", "B2", "c"]);
  });
});
