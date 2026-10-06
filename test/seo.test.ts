import { describe, expect, it } from "vitest";
import { scoreSeo, matchesKeyword } from "../src/seo/score";
import { mergeKeywords, parseSuggest, suggestedTags, pacificDay } from "../src/seo/keywords";
import { youtubeText } from "../server/platforms/text";

const good = {
  title: "Bedtime Story for Toddlers: Pip Learns to Share 🛷 #shorts",
  description:
    "A gentle bedtime story for toddlers about sharing. Pip gets a new red sled and learns that taking turns with Lulu makes the snowy hill even more fun. A calm one-minute read-aloud for ages 2 to 4.\n\n#bedtimestory #kidsstories #shorts",
  hashtags: ["bedtimestory", "kidsstories", "shorts"],
  tags: ["bedtime story for toddlers", "bedtime stories", "story for kids", "sharing story", "read aloud", "toddler story"],
};

describe("scoreSeo", () => {
  it("scores well-tuned text high and explains each check", () => {
    const r = scoreSeo(good, { keyword: "bedtime story for toddlers", kind: "kids" });
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.checks.every((c) => c.label && typeof c.pass === "boolean")).toBe(true);
  });

  it("finds the usual problems", () => {
    const r = scoreSeo(
      { title: "WOW YOU WON'T BELIEVE THIS INSANE MOMENT AT THE END OF THE VIDEO THAT EVERYONE IS TALKING ABOUT TODAY", description: "lol", hashtags: [], tags: [] },
      { keyword: "funny cat", kind: "short" },
    );
    const failed = r.checks.filter((c) => !c.pass).map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["title-keyword", "title-length", "title-caps", "desc-keyword", "desc-length", "hashtags", "shorts-tag", "tags-present"]));
    expect(r.score).toBeLessThan(25);
    expect(r.checks.find((c) => c.id === "title-caps")!.tip).toBeTruthy();
  });

  it("without a keyword it skips the keyword checks instead of failing them", () => {
    const r = scoreSeo(good, { kind: "kids" });
    expect(r.checks.some((c) => c.id === "title-keyword")).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it("kids: a call to action aimed at children fails; long videos don't need #shorts", () => {
    const kids = scoreSeo({ ...good, description: good.description + "\nKids, hit subscribe and smash that like button!" }, { kind: "kids" });
    expect(kids.checks.find((c) => c.id === "kids-cta")!.pass).toBe(false);
    const video = scoreSeo({ ...good, title: "Bedtime Story for Toddlers", hashtags: ["bedtimestory"] }, { kind: "video" });
    expect(video.checks.some((c) => c.id === "shorts-tag")).toBe(false);
  });

  it("more than 60 hashtags makes YouTube ignore all of them", () => {
    const r = scoreSeo({ ...good, hashtags: Array.from({ length: 61 }, (_, i) => `t${i}`) }, { kind: "short" });
    expect(r.checks.find((c) => c.id === "hashtags")!.tip).toMatch(/60/);
  });

  it("matches a keyword by phrase or by all of its words", () => {
    expect(matchesKeyword("Pip's bedtime story, for toddlers!", "bedtime story for toddlers")).toBe(true);
    expect(matchesKeyword("A toddler bedtime tale", "bedtime story for toddlers")).toBe(false);
  });
});

describe("keyword research helpers", () => {
  it("parses YouTube autocomplete (firefox client)", () => {
    expect(parseSuggest(["bedtime story", ["bedtime story", "bedtime stories for kids", "bedtime story for toddlers"]])).toEqual(["bedtime story", "bedtime stories for kids", "bedtime story for toddlers"]);
    expect(parseSuggest({ nope: true })).toEqual([]);
  });

  it("merges sources: terms seen in several places, early in autocomplete, or already bringing viewers rank first", () => {
    const k = mergeKeywords({
      seed: "bedtime story",
      suggest: ["bedtime story", "bedtime stories for kids", "bedtime story for toddlers", "bedtime story asmr"],
      ranking: [
        { id: "a", title: "Bedtime Stories for Kids | Sleepy Bear", channel: "X", views: 2_000_000, tags: ["bedtime stories for kids", "kids story"] },
        { id: "b", title: "Calm bedtime stories for kids", channel: "Y", views: 500_000, tags: ["bedtime stories for kids", "kids story", "sleep"] },
      ],
      yours: [{ term: "bedtime story for toddlers", views: 120 }],
    });
    expect(k[0]!.term).toBe("bedtime stories for kids");
    expect(k[0]!.sources).toEqual(expect.arrayContaining(["autocomplete", "ranking"]));
    const mine = k.find((x) => x.term === "bedtime story for toddlers")!;
    expect(mine.sources).toEqual(expect.arrayContaining(["autocomplete", "yours"]));
    expect(mine.views).toBe(120);
    expect(k.every((x) => x.score >= 0 && x.score <= 100)).toBe(true);
    expect(k.find((x) => x.term === "kids story")?.sources).toEqual(["ranking"]);
  });

  it("suggests tags used by more than one ranking video, most common first", () => {
    expect(
      suggestedTags([
        { id: "a", title: "", channel: "", views: 1, tags: ["Kids Story", "sleep", "one-off"] },
        { id: "b", title: "", channel: "", views: 1, tags: ["kids story", "sleep"] },
        { id: "c", title: "", channel: "", views: 1, tags: ["kids story"] },
      ]),
    ).toEqual(["kids story", "sleep"]);
  });

  it("counts the search quota by Google's Pacific day", () => {
    expect(pacificDay(new Date("2026-10-07T06:30:00Z"))).toBe("2026-10-06");
    expect(pacificDay(new Date("2026-10-07T07:30:00Z"))).toBe("2026-10-07");
  });
});

describe("youtubeText with search tags", () => {
  it("uses the SEO tags (then hashtags) as YouTube tags, within 500 characters", () => {
    const t = youtubeText({ ytTitle: "T", description: "D", hashtags: ["shorts", "kidsstory"], tags: ["bedtime story", "kids story", "bedtime story"] });
    expect(t.tags).toEqual(["bedtime story", "kids story", "shorts", "kidsstory"]);
    const long = youtubeText({ ytTitle: "T", description: "D", hashtags: [], tags: Array.from({ length: 80 }, (_, i) => `keyword number ${i}`) });
    expect(long.tags!.join(",").length).toBeLessThanOrEqual(500);
  });
});
