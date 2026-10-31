import { describe, expect, it } from "vitest";
import { DEFAULT_SLOTS, MAX_PER_WEEKEND, creatorName, easternTime, nextOccurrence, philippineTime, rankValue, recommendSlot, slotResults, weekendKey } from "../lib/longform";
import { hideChat, assText, captionGroups, chapterLines, maskSlurs, cardArgs, clipArgs, concatList, keepRanges, mapTime, rangesLength, readProblems, wordsInCut } from "../src/longform/edit";

const word = (text: string, start: number, end: number) => ({ text, start, end });

describe("upload slots", () => {
  // Friday Nov 6 2026, 12:00 PHT
  const FRI_NOON = Date.UTC(2026, 10, 6, 4);

  it("finds the slot's next time in Philippine time", () => {
    const sat = nextOccurrence(DEFAULT_SLOTS[0]!, FRI_NOON);
    expect(philippineTime(sat)).toBe("Sat, Nov 7, 9:00 AM PHT");
    expect(easternTime(sat)).toBe("Fri, Nov 6, 8:00 PM ET");
    expect(philippineTime(nextOccurrence(DEFAULT_SLOTS[2]!, FRI_NOON))).toBe("Fri, Nov 6, 4:00 PM PHT");
    // the moment it passes, it moves a week on
    expect(philippineTime(nextOccurrence(DEFAULT_SLOTS[0]!, sat))).toBe("Sat, Nov 14, 9:00 AM PHT");
  });

  it("treats Friday to Sunday as one weekend", () => {
    const fri = nextOccurrence(DEFAULT_SLOTS[2]!, FRI_NOON);
    const sat = nextOccurrence(DEFAULT_SLOTS[0]!, FRI_NOON);
    const sun = nextOccurrence(DEFAULT_SLOTS[1]!, FRI_NOON);
    expect(weekendKey(fri)).toBe(weekendKey(sat));
    expect(weekendKey(sat)).toBe(weekendKey(sun));
    expect(weekendKey(sun)).not.toBe(weekendKey(sun + 7 * 86400_000));
  });

  it("tries every slot, and caps a weekend", () => {
    const taken: { at: number; slotId?: string }[] = [];
    const used: string[] = [];
    for (let i = 0; i < 6; i++) {
      const pick = recommendSlot(DEFAULT_SLOTS, taken, FRI_NOON)!;
      used.push(pick.slot.id);
      taken.push({ at: pick.at, slotId: pick.slot.id });
    }
    for (const s of DEFAULT_SLOTS) expect(used.filter((u) => u === s.id)).toHaveLength(2);
    const perWeekend = new Map<number, number>();
    for (const t of taken) perWeekend.set(weekendKey(t.at), (perWeekend.get(weekendKey(t.at)) ?? 0) + 1);
    expect(Math.max(...perWeekend.values())).toBeLessThanOrEqual(MAX_PER_WEEKEND);
    expect(new Set(taken.map((t) => t.at)).size).toBe(6);
  });

  it("names no winner until a slot has enough results", () => {
    const m = (views: number) => ({ at: 0, ageHours: 168 as const, views, philippinesViews: 1 });
    const results = slotResults(DEFAULT_SLOTS, [
      { slotId: "sat-am", metrics: [m(10)] },
      { slotId: "sat-am", metrics: [m(20), { at: 0, ageHours: 48, views: 999, philippinesViews: 0 }] },
      { slotId: "sat-am", metrics: [m(30)] },
      { slotId: "sun-am", metrics: [m(500)] },
    ]);
    expect(results[0]).toMatchObject({ videos: 3, avgViews: 20, comparable: true });
    expect(results[1]).toMatchObject({ videos: 1, comparable: false });
  });
});

describe("ranking", () => {
  it("lets real views separate clips with the same AI score", () => {
    expect(rankValue({ score: 8, views: 1000 })).toBeGreaterThan(rankValue({ score: 8, views: 10 }));
    expect(rankValue({ score: 8 })).toBe(8);
    expect(rankValue({ score: 8, views: 1e12 })).toBe(10);
  });
  it("treats one person's channels as one creator", () => {
    expect(creatorName("Live Speedy")).toBe(creatorName("IShowSpeed"));
    expect(creatorName("Kai Cenat Live")).toBe("Kai Cenat");
    expect(creatorName("RAY LIVE")).toBe("Ray");
  });
});

describe("the edit", () => {
  const words = [word("hi", 11, 11.5), word("there", 11.6, 12), word("later", 20, 20.5), word("bye", 20.6, 21)];

  it("starts on the first word, ends after the last, and shortens long silences", () => {
    const r = keepRanges(words, 10, 25);
    expect(r).toEqual([
      { start: 10.8, end: 12.6 },
      { start: 19.4, end: 21.5 },
    ]);
    expect(rangesLength(r)).toBe(3.9);
  });

  it("keeps short pauses and uses the whole window when nobody talks", () => {
    expect(keepRanges(words.slice(0, 2), 10, 25)).toHaveLength(1);
    expect(keepRanges([], 10, 25)).toEqual([{ start: 10, end: 25 }]);
  });

  it("retimes words to the cut and drops what was cut out", () => {
    const r = [{ start: 11, end: 12 }, { start: 20, end: 21 }];
    expect(mapTime(r, 20.5)).toBe(1.5);
    expect(mapTime(r, 15)).toBeNull();
    expect(wordsInCut(words, r).map((w) => [w.text, w.start])).toEqual([["hi", 0], ["there", 0.6], ["later", 1], ["bye", 1.6]]);
  });

  it("makes captions short, and breaks them at pauses", () => {
    const g = captionGroups([word("a", 0, 0.2), word("b", 0.3, 0.5), word("c", 2, 2.2)]);
    expect(g.map((x) => x.text)).toEqual(["a b", "c"]);
  });

  it("can't be broken by text from a title", () => {
    expect(assText("big {\\pos(0,0)} win 🔥\\N")).toBe("big /pos(0,0) win /N");
  });

  it("names captions files bare and joins several ranges", () => {
    const args = clipArgs({ footage: "/a b/f.mp4", ranges: [{ start: 1, end: 2 }, { start: 5, end: 7 }], ass: "x.ass", out: "o.mp4", enc: "libx264" });
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("concat=n=2:v=1:a=1");
    expect(filter).toContain("ass=filename=x.ass");
    expect(filter).toContain("loudnorm=I=-14");
    expect(args[args.indexOf("-t") + 1]).toBe("3");
  });

  it("keeps the narrator over the footage's sound on cards", () => {
    const args = cardArgs({ footage: "f.mp4", offset: 2, narration: "n.wav", seconds: 6, lead: 0.35, ass: "c.ass", out: "o.mp4", enc: "libx264" });
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("volume=0.08");
    expect(filter).toContain("adelay=delays=350:all=1");
  });

  it("fades the chat blur out instead of ending on a hard line", () => {
    const f = hideChat("in", "out");
    expect(f).toContain("alphamerge");
    expect(f).toContain("loop=loop=-1:size=1");
    expect(f.endsWith("[out]")).toBe(true);
  });

  it("quotes file names when joining", () => {
    expect(concatList(["/a/it's.mp4"])).toBe("file '/a/it'\\''s.mp4'\n");
  });

  it("never spells a slur out in captions, and leaves other words alone", () => {
    expect(maskSlurs("nah nigga what")).toBe("nah n**** what");
    expect(maskSlurs("that retarded thing")).toBe("that r******* thing");
    expect(maskSlurs("Nigeria snigger faggots shop")).toBe("Nigeria snigger f****** shop");
    expect(captionGroups([word("my", 0, 0.1), word("nigga", 0.2, 0.5)])[0]!.text).toBe("my n****");
  });

  it("writes chapters YouTube will accept", () => {
    const parts = [
      { title: "Intro", seconds: 12 },
      { title: "", seconds: 30 },
      { title: "#2 Second", seconds: 5 },
      { title: "", seconds: 70 },
      { title: "#1 First", seconds: 3700 },
    ];
    expect(chapterLines(parts)).toEqual(["0:00 Intro", "0:42 #2 Second", "1:57 #1 First"]);
    expect(chapterLines([{ title: "a", seconds: 5 }, { title: "b", seconds: 5 }, { title: "c", seconds: 5 }])).toEqual([]);
    expect(chapterLines([{ title: "a", seconds: 3600 }, { title: "b", seconds: 60 }, { title: "c", seconds: 60 }])[2]).toBe("1:01:00 c");
  });

  it("reads problems from ffmpeg's log", () => {
    expect(readProblems("black_start:10 black_end:15 black_duration:5\nsilence_end: 40.5 | silence_duration: 7.2")).toEqual(["5.0s of black at 10s", "7.2s of silence ending at 41s"]);
  });
});
