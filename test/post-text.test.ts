import { describe, expect, it } from "vitest";
import { instagramText, tiktokText, youtubeText } from "../server/platforms/text";

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
