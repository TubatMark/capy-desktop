import { describe, expect, it } from "vitest";
import { parseJson3, snapToWords, transcriptForPrompt, wordsInRange, parseWhisperJson } from "../src/captions";
import { postProcess, picksJsonSchema } from "../src/pick";
import { pickCaptionLang, videoIdFromUrl } from "../src/youtube";
import { upscaleFactor, verticalFilter } from "../src/render";
import { assTime, buildAss, cleanCaptionWords, groupWords, STYLES } from "../src/ass";
import type { Word } from "../src/types";

const json3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Hello", tOffsetMs: 0 }, { utf8: " world.", tOffsetMs: 800 }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: "\n" }] },
    { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: "This is a test" }] },
  ],
});

describe("parseJson3", () => {
  it("parses timed and untimed segments", () => {
    const w = parseJson3(json3);
    expect(w.map((x) => x.text)).toEqual(["Hello", "world.", "This", "is", "a", "test"]);
    expect(w[0]).toMatchObject({ start: 0, end: 0.8 });
    expect(w[1]!.end).toBeCloseTo(2);
    expect(w[2]!.start).toBe(3);
    expect(w[5]!.end).toBeCloseTo(5);
  });
  it("clamps overlapping cue timings and long words", () => {
    const w = parseJson3(JSON.stringify({ events: [
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: "one" }] },
      { tStartMs: 1000, dDurationMs: 6000, segs: [{ utf8: "two" }] },
    ] }));
    expect(w[0]!.end).toBeCloseTo(1);
    expect(w[1]!.end).toBeCloseTo(2.5);
  });
});

describe("parseWhisperJson", () => {
  it("reads openai-style segments with words", () => {
    const w = parseWhisperJson(JSON.stringify({ segments: [{ start: 0, end: 1, text: "hi there", words: [{ word: " hi", start: 0, end: 0.4 }, { word: " there", start: 0.4, end: 1 }] }] }));
    expect(w).toEqual([{ text: "hi", start: 0, end: 0.4 }, { text: "there", start: 0.4, end: 1 }]);
  });
  it("merges whisper.cpp sub-word tokens", () => {
    const w = parseWhisperJson(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: " unbelievable", tokens: [{ text: " unbe", offsets: { from: 0, to: 300 } }, { text: "liev", offsets: { from: 300, to: 600 } }, { text: "able", offsets: { from: 600, to: 1000 } }] }] }));
    expect(w).toEqual([{ text: "unbelievable", start: 0, end: 1 }]);
  });
});

const sentence = (texts: string[], start = 0, each = 0.5): Word[] => texts.map((t, i) => ({ text: t, start: start + i * each, end: start + (i + 1) * each }));

describe("snapToWords", () => {
  const words = [...sentence(["Okay", "so", "here's", "the", "thing."], 0), ...sentence(["Nobody", "tells", "you", "this."], 2.5), ...sentence(["It", "matters."], 4.5)];
  it("moves the start to a sentence boundary and the end to a sentence end", () => {
    const r = snapToWords(words, 2.7, 4.6);
    expect(r.start).toBeCloseTo(2.5 - 0.15);
    expect(r.end).toBeCloseTo(5.5 + 0.25);
  });
  it("does not walk back past slack", () => {
    const r = snapToWords(words, 4.6, 5.4, 0.5);
    expect(r.start).toBeCloseTo(4.5 - 0.15);
  });
  it("passes through with no words", () => {
    expect(snapToWords([], 1, 2)).toEqual({ start: 1, end: 2 });
  });
});

describe("postProcess", () => {
  const words = sentence(Array.from({ length: 400 }, (_, i) => (i % 10 === 9 ? "end." : "w")), 0, 0.5); // 200s
  it("drops overlaps keeping the higher score, clamps length, sorts by time", () => {
    const clips = postProcess(
      [
        { start: 100, end: 130, title: "b", hook: "", reason: "", score: 6 },
        { start: 10, end: 40, title: "a", hook: "", reason: "", score: 8 },
        { start: 20, end: 50, title: "a2", hook: "", reason: "", score: 5 },
        { start: 150, end: 250, title: "long", hook: "", reason: "", score: 7 },
        { start: 160, end: 162, title: "tiny", hook: "", reason: "", score: 9 },
      ],
      words,
      200,
      { minSec: 20, maxSec: 60 },
    );
    expect(clips.map((c) => c.title)).toEqual(["a", "b", "long"]);
    expect(clips[2]!.end - clips[2]!.start).toBeLessThanOrEqual(60);
  });
});

describe("wordsInRange / transcriptForPrompt", () => {
  const words = sentence(["a", "b", "c", "d"], 10, 1);
  it("rebases times to the clip", () => {
    expect(wordsInRange(words, 11, 13)).toEqual([{ text: "b", start: 0, end: 1 }, { text: "c", start: 1, end: 2 }]);
  });
  it("emits timestamped lines", () => {
    expect(transcriptForPrompt(words, 2)).toBe("[10] a b\n[12] c d");
  });
});

describe("youtube helpers", () => {
  it("extracts ids", () => {
    expect(videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1")).toBe("dQw4w9WgXcQ");
    expect(videoIdFromUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(videoIdFromUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(videoIdFromUrl("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(videoIdFromUrl("https://vimeo.com/1")).toBeNull();
  });
  it("prefers manual subs, then auto, honoring language", () => {
    const base = { id: "", title: "", duration: 0, url: "" };
    expect(pickCaptionLang({ ...base, subtitles: ["en"], autoCaptions: ["en"] })).toEqual({ lang: "en", auto: false });
    expect(pickCaptionLang({ ...base, subtitles: [], autoCaptions: ["en", "en-fr", "fil"] }, "fil")).toEqual({ lang: "fil", auto: true });
    expect(pickCaptionLang({ ...base, language: "tl", subtitles: [], autoCaptions: ["tl", "en"] })).toEqual({ lang: "tl", auto: true });
    expect(pickCaptionLang({ ...base, subtitles: [], autoCaptions: [] })).toBeNull();
    // region-tagged language ("en-US") must not fall through to some other language's -orig track
    const dubbed = ["ar-orig", "en", "bn-orig", "en-orig", "pt-BR-orig", "es-US-orig", "fr"];
    expect(pickCaptionLang({ ...base, language: "en-US", subtitles: [], autoCaptions: dubbed })).toEqual({ lang: "en-orig", auto: true });
    expect(pickCaptionLang({ ...base, language: "pt-BR", subtitles: [], autoCaptions: dubbed })).toEqual({ lang: "pt-BR-orig", auto: true });
    expect(pickCaptionLang({ ...base, subtitles: [], autoCaptions: ["ar-orig", "bn-orig", "fr"] })).toEqual({ lang: "ar-orig", auto: true });
    // original-language auto track beats auto-translated English
    expect(pickCaptionLang({ ...base, subtitles: [], autoCaptions: ["en", "tl-orig", "tl"] })).toEqual({ lang: "tl-orig", auto: true });
    expect(pickCaptionLang({ ...base, language: "en", subtitles: [], autoCaptions: ["en-orig", "en", "fr"] })).toEqual({ lang: "en-orig", auto: true });
  });
});

describe("ass", () => {
  it("formats times", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(3723.456)).toBe("1:02:03.45");
  });
  it("groups on sentence ends and limits", () => {
    const g = groupWords(sentence(["a", "b.", "c", "d", "e", "f", "g"], 0, 0.2), 4, 10);
    expect(g.map((x) => x.length)).toEqual([2, 4, 1]);
  });
  it("builds one dialogue per word state plus a hook", () => {
    const ass = buildAss(sentence(["hi", "there"], 0, 0.5), { ...STYLES.bold!, groupWords: 4, groupSec: 3, groupChars: 30, highlight: "&H0000FFFF", primary: "&H00FFFFFF" }, { text: "Wait {for} it 🔥", seconds: 2 });
    const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(3);
    expect(dialogues[0]).toContain("Hook,,0,0,0,,WAIT (FOR) IT");
    expect(dialogues[1]).toContain("{\\c&H0000FFFF}HI{\\c&H00FFFFFF} THERE");
  });
});

describe("picksJsonSchema", () => {
  it("has no $schema tag and describes clips", () => {
    const s = picksJsonSchema() as any;
    expect(s.$schema).toBeUndefined();
    expect(s.type).toBe("object");
    expect(s.properties.clips.type).toBe("array");
  });
});

describe("regressions from e2e review", () => {
  it("does not leak the previous sentence's last word into the clip", () => {
    const words = sentence(["in", "RIO."], 9, 0.5).concat(sentence(["Nobody", "tells", "you"], 10.3, 0.4));
    // "RIO." ends at 10.0 — after a cut at 9.9 it used to show at 0:00
    expect(wordsInRange(words, 9.9, 12).map((w) => w.text)).toEqual(["Nobody", "tells", "you"]);
  });
  it("clamps long clips on a word end, not mid-word", () => {
    const words = sentence(Array.from({ length: 300 }, () => "word"), 0, 0.37);
    const [c] = postProcess([{ start: 10, end: 100, title: "t", hook: "", reason: "", score: 5 }], words, 111, { minSec: 20, maxSec: 60 });
    expect(c!.end - c!.start).toBeLessThanOrEqual(60);
    const cutAt = c!.end - 0.25;
    expect(words.some((w) => Math.abs(w.end - cutAt) < 1e-6)).toBe(true);
  });
  it("keeps back-to-back clips", () => {
    const words = sentence(Array.from({ length: 400 }, (_, i) => (i % 10 === 9 ? "end." : "w")), 0, 0.5);
    const clips = postProcess(
      [{ start: 20, end: 50, title: "a", hook: "", reason: "", score: 8 }, { start: 50, end: 80, title: "b", hook: "", reason: "", score: 7 }],
      words, 200, { minSec: 20, maxSec: 60 },
    );
    expect(clips.map((c) => c.title)).toEqual(["a", "b"]);
  });
  it("snaps on pauses when captions have no punctuation", () => {
    const words = [...sentence(["so", "yeah", "anyway"], 0, 0.3), ...sentence(["the", "real", "secret", "is", "this"], 2.0, 0.3)];
    expect(snapToWords(words, 2.35, 3.3).start).toBeCloseTo(2.0 - 0.15);
    expect(snapToWords(words, 0, 0.5).end).toBeCloseTo(0.9 + 0.25); // ends before the pause
  });
  it("does not crash snapping at the very end of the transcript", () => {
    const words = sentence(["a", "b", "c"], 0, 0.3);
    expect(snapToWords(words, 0, 5).end).toBeCloseTo(0.9 + 0.25);
  });
  it("wraps: groups respect a character budget and pauses", () => {
    const g = groupWords(sentence(["napakaganda", "talaga", "nito", "grabe"], 0, 0.3), 5, 10, 14);
    expect(g.every((x) => x.map((w) => w.text).join(" ").length <= 14 || x.length === 1)).toBe(true);
    const p = groupWords([{ text: "a", start: 0, end: 0.2 }, { text: "b", start: 1.5, end: 1.7 }], 5, 10);
    expect(p).toHaveLength(2);
    expect(buildAss([], STYLES.bold!)).toContain("WrapStyle: 0");
  });
  it("drops [Music], >> and emoji from burned-in captions", () => {
    const w = cleanCaptionWords([{ text: "[Music]", start: 0, end: 1 }, { text: ">>", start: 1, end: 1.1 }, { text: "wow🔥", start: 1.1, end: 1.5 }, { text: "😂", start: 1.5, end: 2 }]);
    expect(w.map((x) => x.text)).toEqual(["wow"]);
  });
  it("clean style writes one line per group (no per-word highlight)", () => {
    const ass = buildAss(sentence(["one", "two", "three"], 0, 0.3), STYLES.clean!);
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:"))).toHaveLength(1);
  });
});

describe("render quality helpers", () => {
  it("knows when the crop has to enlarge the source", () => {
    expect(upscaleFactor({ width: 1920, height: 1080 }, "center")).toBeCloseTo(1.78, 2); // 1080p gets stretched
    expect(upscaleFactor({ width: 3840, height: 2160 }, "center")).toBeCloseTo(0.89, 2); // 4K gets scaled down
    expect(upscaleFactor({ width: 1920, height: 1080 }, "blur")).toBeCloseTo(0.5625, 3);
  });
  it("uses lanczos and only sharpens when asked", () => {
    expect(verticalFilter("center", true)).toContain("flags=lanczos");
    expect(verticalFilter("center", true)).toContain("unsharp");
    expect(verticalFilter("center", false)).not.toContain("unsharp");
  });
});
