import { describe, expect, it } from "vitest";
import { bestPostTimes, audienceTz } from "../lib/post-time";

describe("bestPostTimes", () => {
  // Wednesday 2026-09-23 10:00 UTC
  const now = new Date("2026-09-23T10:00:00Z");
  it("returns future slots, best first, with Friday on top", () => {
    const s = bestPostTimes("America/New_York", "Asia/Manila", now, 3);
    expect(s).toHaveLength(3);
    expect(s[0]!.dayName).toBe("Friday");
    expect(s.every((x) => x.at.getTime() > now.getTime())).toBe(true);
    expect(s[0]!.score).toBeGreaterThanOrEqual(s[1]!.score);
  });
  it("converts audience-local 5pm ET to the right UTC (EDT = UTC-4)", () => {
    const s = bestPostTimes("America/New_York", "UTC", now, 1);
    expect(s[0]!.at.toISOString()).toBe("2026-09-25T21:00:00.000Z");
    expect(s[0]!.utc).toContain("9:00 PM");
    expect(s[0]!.audienceLocal).toContain("5:00 PM");
  });
  it("works for Manila audience (UTC+8)", () => {
    const s = bestPostTimes("Asia/Manila", "UTC", now, 1);
    expect(s[0]!.at.toISOString()).toBe("2026-09-25T09:00:00.000Z");
  });
  it("skips slots less than 30 min away", () => {
    const fri = new Date("2026-09-25T20:45:00Z"); // 4:45pm ET Friday — the 5pm slot is 15 min out
    const s = bestPostTimes("America/New_York", "UTC", fri, 5);
    expect(s.some((x) => x.at.toISOString() === "2026-09-25T21:00:00.000Z")).toBe(false);
  });
  it("defaults the audience to US East", () => {
    expect(audienceTz(undefined)).toBe("America/New_York");
    expect(audienceTz("ph")).toBe("Asia/Manila");
  });
});
