import { describe, expect, it } from "vitest";
import { instagramText, shortsTitle, tiktokText, youtubeText } from "../server/platforms/text";

const p = {
  ytTitle: "Mia almost misses the flight ✈️ #travel #shorts",
  description: "What happens.\nWould you wait?\nCredit: Mia\n#travel #mia #shorts",
  hashtags: ["travel", "#mia", "shorts"],
};

describe("post text", () => {
  it("youtube: title ≤100, tags without # and ≤500 chars total, keeps the credit", () => {
    const t = youtubeText({ ...p, ytTitle: "x".repeat(140), hashtags: Array.from({ length: 80 }, (_, i) => `tag${i}`) });
    expect(t.title!.length).toBeLessThanOrEqual(100);
    expect(t.tags!.every((x) => !x.startsWith("#"))).toBe(true);
    expect(t.tags!.join(",").length).toBeLessThanOrEqual(500);
    expect(t.description).toContain("Credit: Mia");
  });
  it("instagram: hook first, ≤30 hashtags, ≤2200 chars, hashtags only once", () => {
    const t = instagramText({ ...p, hashtags: Array.from({ length: 40 }, (_, i) => `h${i}`) }, "Mia almost misses it");
    expect(t.caption!.startsWith("Mia almost misses it")).toBe(true);
    expect((t.caption!.match(/#\w+/g) ?? []).length).toBeLessThanOrEqual(30);
    expect(t.caption!.length).toBeLessThanOrEqual(2200);
    expect(t.caption).toContain("Credit: Mia");
  });
  it("tiktok: title without hashtags, then hashtags, ≤2200", () => {
    const t = tiktokText({ ...p, description: "y".repeat(5000) });
    expect(t.caption!.length).toBeLessThanOrEqual(2200);
    expect(t.caption!.startsWith("Mia almost misses the flight ✈️")).toBe(true);
    expect(t.caption).toContain("#mia");
  });
});

describe("shortsTitle", () => {
  const desc = "DDG gets a gift.\nCredit: DDG\n#DDG #Birthday #Stream #Shorts";
  it("adds the creator, the topic and #shorts from the description's hashtag line", () => {
    expect(shortsTitle("DDG custom gift surprise 😭", desc)).toBe("DDG custom gift surprise 😭 #ddg #birthday #shorts");
  });
  it("prefers the clip's own hashtags over the description", () => {
    expect(shortsTitle("Rakai Prays For Reggie 🙏", desc, ["rakai", "#fortnite", "shorts"])).toBe("Rakai Prays For Reggie 🙏 #rakai #fortnite #shorts");
  });
  it("leaves a title with hashtags alone, only adding a missing #shorts", () => {
    expect(shortsTitle("IShowSpeed WINS the wager 🔥 #ishowspeed #nba2k #shorts", desc)).toBe("IShowSpeed WINS the wager 🔥 #ishowspeed #nba2k #shorts");
    expect(shortsTitle("Kai Cenat roast 💀 #kaicenat", desc)).toBe("Kai Cenat roast 💀 #kaicenat #shorts");
  });
  it("falls back to #shorts alone and never passes 100 characters", () => {
    expect(shortsTitle("Plain title", "no tags here")).toBe("Plain title #shorts");
    const long = shortsTitle("y".repeat(90), desc);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long).toBe(`${"y".repeat(90)} #ddg`);
  });
  it("youtubeText uses it", () => {
    expect(youtubeText({ ytTitle: "Mia almost misses the flight ✈️", description: "x", hashtags: ["mia", "travel"] }).title).toBe("Mia almost misses the flight ✈️ #mia #travel #shorts");
  });
});
