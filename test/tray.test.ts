import { describe, expect, it } from "vitest";
import { trayMenuModel } from "../electron/tray-model";

describe("trayMenuModel", () => {
  const tz = "America/New_York";
  it("shows the next post with its platforms", () => {
    const m = trayMenuModel({ nextPost: { at: Date.parse("2026-10-09T21:00:00Z"), platforms: ["instagram", "tiktok"] }, activeCount: 2, review: 0 }, false, tz);
    expect(m[0]!.label).toBe("Next post: Fri 5:00 PM · Instagram, TikTok");
    expect(m.map((x) => x.id)).toEqual(expect.arrayContaining(["open", "pause", "quit"]));
    expect(m.find((x) => x.id === "pause")!.label).toBe("Pause posting");
  });
  it("says when nothing is scheduled, counts reviews, and offers resume when paused", () => {
    const m = trayMenuModel({ activeCount: 0, review: 3 }, true, tz);
    expect(m[0]!.label).toBe("No posts scheduled");
    expect(m.some((x) => x.label === "3 clips waiting for your OK")).toBe(true);
    expect(m.find((x) => x.id === "pause")!.label).toBe("Resume posting");
    expect(m.find((x) => x.id === "quit")!.label).toBe("Quit capy");
  });
});

import { newReviewNotice } from "../electron/tray-model";
describe("tray: automation", () => {
  it("shows how many creators are watched", () => {
    const m = trayMenuModel({ activeCount: 0, review: 0, watching: 2 }, false, "America/New_York");
    expect(m.some((x) => x.label === "Watching 2 creators")).toBe(true);
    expect(trayMenuModel({ activeCount: 0, review: 0 }, false, "America/New_York").some((x) => x.label.startsWith("Watching"))).toBe(false);
  });
  it("notifies only when more clips are waiting than before", () => {
    expect(newReviewNotice(undefined, 3)).toBeUndefined(); // first look after start-up: no burst of old news
    expect(newReviewNotice(1, 3)).toBe("2 new clips are waiting for your OK");
    expect(newReviewNotice(0, 1)).toBe("1 new clip is waiting for your OK");
    expect(newReviewNotice(3, 3)).toBeUndefined();
    expect(newReviewNotice(3, 1)).toBeUndefined();
  });
});
