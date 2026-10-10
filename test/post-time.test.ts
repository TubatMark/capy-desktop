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

import { allocateSlot } from "../lib/post-time";

describe("allocateSlot", () => {
  const tz = "America/New_York";
  const now = new Date("2026-09-23T10:00:00Z"); // Wed 6:00 ET
  const hourET = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(d)) % 24;
  const dayET = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t));

  it("gives a slot later today when nothing is taken", () => {
    const d = allocateSlot([], ["youtube"], tz, now)!;
    expect(d.getTime()).toBeGreaterThan(now.getTime() + 30 * 60_000);
    expect(dayET(d.getTime())).toBe(dayET(now.getTime()));
  });
  it("puts at most 3 per platform per local day, 5h apart, so 6 clips span 2 days", () => {
    const taken: { platform: "youtube"; at: number }[] = [];
    for (let i = 0; i < 6; i++) taken.push({ platform: "youtube", at: allocateSlot(taken, ["youtube"], tz, now)!.getTime() });
    const days = new Map<string, number[]>();
    for (const t of taken) days.set(dayET(t.at), [...(days.get(dayET(t.at)) ?? []), t.at]);
    expect(days.size).toBe(2);
    for (const ts of days.values()) {
      expect(ts.length).toBe(3);
      ts.sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(5 * 3600_000);
    }
  });
  it("needs every chosen platform free at the shared time", () => {
    const first = allocateSlot([], ["youtube", "tiktok"], tz, now)!;
    const second = allocateSlot([{ platform: "tiktok", at: first.getTime() }], ["youtube", "tiktok"], tz, now)!;
    expect(second.getTime() - first.getTime()).toBeGreaterThanOrEqual(5 * 3600_000);
    expect(allocateSlot([{ platform: "tiktok", at: first.getTime() }], ["youtube"], tz, now)!.getTime()).toBe(first.getTime());
  });
  it("only uses candidate hours in the audience zone", () => {
    const d = allocateSlot([], ["instagram"], tz, now)!;
    expect([10, 11, 12, 15, 16, 17, 18, 19, 20, 21, 22]).toContain(hourET(d));
  });
  it("returns null when the horizon is full", () => {
    const taken: { platform: "youtube"; at: number }[] = [];
    let d: Date | null;
    while ((d = allocateSlot(taken, ["youtube"], tz, now, 2))) taken.push({ platform: "youtube", at: d.getTime() });
    expect(taken.length).toBeLessThanOrEqual(6);
    expect(taken.length).toBeGreaterThan(0);
  });
  it("survives the spring-forward DST change without duplicate slots", () => {
    const spring = new Date("2027-03-13T12:00:00Z");
    const taken: { platform: "youtube"; at: number }[] = [];
    for (let i = 0; i < 6; i++) taken.push({ platform: "youtube", at: allocateSlot(taken, ["youtube"], tz, spring)!.getTime() });
    expect(new Set(taken.map((t) => t.at)).size).toBe(6);
  });
});

import { zonedToUtc } from "../lib/post-time";
describe("zonedToUtc", () => {
  it("converts an ET wall-clock time with minutes to UTC", () => {
    expect(zonedToUtc(2026, 10, 8, 17, 30, "America/New_York").toISOString()).toBe("2026-10-08T21:30:00.000Z");
  });
});
