import { describe, expect, it } from "vitest";
import { hexToAss, LOOK_DEFAULTS, LOOK_LIMITS, normalizeLook, VIBES } from "../lib/look";
import { buildAss, STYLES, styleFor } from "../src/ass";
import { vibeFilter } from "../src/render";
import type { Word } from "../src/types";

const sentence = (texts: string[], start = 0, each = 0.5): Word[] => texts.map((t, i) => ({ text: t, start: start + i * each, end: start + (i + 1) * each }));

describe("hexToAss", () => {
  it("writes &HAABBGGRR", () => {
    expect(hexToAss("#ffe500")).toBe("&H0000E5FF");
    expect(hexToAss("#000000", 0xb4)).toBe("&HB4000000");
    expect(hexToAss("#123456", 0x60)).toBe("&H60563412");
  });
  it("falls back to white for a bad hex", () => {
    expect(hexToAss("red")).toBe("&H00FFFFFF");
  });
});

describe("normalizeLook", () => {
  it("returns the style defaults for nothing", () => {
    expect(normalizeLook(undefined, "bold")).toEqual(LOOK_DEFAULTS.bold);
    expect(normalizeLook(null, "clean")).toEqual(LOOK_DEFAULTS.clean);
    expect(normalizeLook({}, "clean")).toEqual(LOOK_DEFAULTS.clean);
  });
  it("clamps numbers and rounds sizes", () => {
    const l = normalizeLook({ size: 999, bottom: 0.01, wordsPerLine: 2.4, outlineWidth: -3, hook: { size: 1, top: 0.9 } }, "bold");
    expect(l.size).toBe(LOOK_LIMITS.size.max);
    expect(l.bottom).toBe(LOOK_LIMITS.bottom.min);
    expect(l.wordsPerLine).toBe(2);
    expect(l.outlineWidth).toBe(0);
    expect(l.hook.size).toBe(LOOK_LIMITS.hookSize.min);
    expect(l.hook.top).toBe(LOOK_LIMITS.hookTop.max);
  });
  it("drops bad hex, non-numbers and unknown vibes", () => {
    const l = normalizeLook({ text: "red", highlight: "#ABCDEF", size: "big", box: "yes", vibe: "neon", hook: { box: "#12345" } }, "bold");
    expect(l.text).toBe("#ffffff");
    expect(l.highlight).toBe("#abcdef");
    expect(l.size).toBe(76);
    expect(l.box).toBe(false);
    expect(l.vibe).toBe("original");
    expect(l.hook.box).toBe("#000000");
  });
});

describe("styleFor", () => {
  it("reproduces the base styles without a look", () => {
    expect(styleFor("bold")).toEqual(STYLES.bold);
    expect(styleFor("clean")).toEqual(STYLES.clean);
    expect(styleFor("bold", null)).toEqual(STYLES.bold);
  });
  it("applies a look", () => {
    const s = styleFor("bold", {
      ...LOOK_DEFAULTS.bold,
      size: 38, // below the minimum: clamped to 44
      bottom: 0.25,
      wordsPerLine: 2,
      text: "#ffe500",
      highlight: "#ff0000",
      outline: "#112233",
      outlineWidth: 2,
      box: true,
      hook: { size: 100, text: "#00ff00", box: "#0000ff", top: 0.1 },
      vibe: "warm",
    });
    expect(s.size).toBe(44);
    expect(s.marginV).toBe(480);
    expect(s.groupWords).toBe(2);
    expect(s.groupChars).toBe(Math.round((14 * 76) / 44));
    expect(s.primary).toBe("&H0000E5FF");
    expect(s.highlight).toBe("&H000000FF");
    expect(s.outline).toBe("&H00332211");
    expect(s.outlineWidth).toBe(2);
    expect(s.box).toBe(true);
    expect(s.hookSize).toBe(100);
    expect(s.hookPrimary).toBe("&H0000FF00");
    expect(s.hookBack).toBe("&HB4FF0000");
    expect(s.hookMarginV).toBe(192);
    expect(s.font).toBe(STYLES.bold!.font);
    expect(s.uppercase).toBe(true);
  });
  it("keeps the character budget sane for huge text", () => {
    expect(styleFor("clean", { ...LOOK_DEFAULTS.clean, size: 120 }).groupChars).toBe(Math.max(6, Math.round((24 * 64) / 120)));
  });
});

describe("buildAss with a look", () => {
  const capLine = (ass: string) => ass.split("\n").find((l) => l.startsWith("Style: Cap,"))!;
  const hookLine = (ass: string) => ass.split("\n").find((l) => l.startsWith("Style: Hook,"))!;
  it("draws an opaque box (BorderStyle 3) from the outline colour", () => {
    const ass = buildAss(sentence(["hi"]), styleFor("bold", { ...LOOK_DEFAULTS.bold, box: true, outline: "#112233" }));
    // ..., OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, ...
    expect(capLine(ass)).toMatch(/,&H00332211,&H60332211,-1,0,0,0,100,100,0,0,3,5,/);
  });
  it("keeps BorderStyle 1 and the default hook line without a look", () => {
    const ass = buildAss(sentence(["hi"]), styleFor("bold"), { text: "Wait", seconds: 1 });
    expect(capLine(ass)).toMatch(/,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,/);
    expect(hookLine(ass)).toBe("Style: Hook,Arial Black,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,-1,0,0,0,100,100,1,0,3,18,0,8,70,70,300,1");
  });
  it("moves and recolours the hook", () => {
    const ass = buildAss([], styleFor("clean", { ...LOOK_DEFAULTS.clean, hook: { size: 90, text: "#ffe500", box: "#ffffff", top: 0.2 } }), { text: "Wait", seconds: 1 });
    expect(hookLine(ass)).toBe("Style: Hook,Helvetica,90,&H0000E5FF,&H0000E5FF,&H00000000,&HB4FFFFFF,-1,0,0,0,100,100,1,0,3,18,0,8,70,70,384,1");
  });
});

describe("vibeFilter", () => {
  it("is empty for the original colours and an ffmpeg chain otherwise", () => {
    expect(vibeFilter("original")).toBe("");
    expect(vibeFilter("vivid")).toBe("eq=contrast=1.12:saturation=1.4");
    for (const v of VIBES) expect(vibeFilter(v.id)).toBe(v.ffmpeg);
  });
});
