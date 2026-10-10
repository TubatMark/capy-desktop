import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  bucketByDay,
  countKinds,
  dayKey,
  entryKind,
  entryTime,
  fmtDay,
  metricValue,
  missingReason,
  monthGrid,
  nearestDay,
  postThumb,
  publicationsFor,
} from "../lib/queue-calendar";
import type { QueueEntry } from "../lib/types";
import type { PerformancePublication } from "../lib/performance";

const entry = (over: Partial<QueueEntry>): QueueEntry => ({
  key: "j:1:youtube",
  jobId: "j",
  n: 1,
  platform: "youtube",
  status: "scheduled",
  clipTitle: "Clip",
  text: {},
  attempts: 0,
  history: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("dayKey", () => {
  it("uses the audience zone, not UTC, near midnight", () => {
    // 03:30 UTC on Oct 11 is still Oct 10 in New York (EDT, UTC-4)
    const t = Date.UTC(2026, 9, 11, 3, 30);
    expect(dayKey(t, "America/New_York")).toBe("2026-10-10");
    expect(dayKey(t, "UTC")).toBe("2026-10-11");
    // and already Oct 11 in Manila (UTC+8)
    expect(dayKey(Date.UTC(2026, 9, 10, 16, 0), "Asia/Manila")).toBe(
      "2026-10-11",
    );
  });
  it("handles daylight saving changes", () => {
    // US clocks fall back on Nov 1 2026 at 2am; before that New York is UTC-4, so 04:59 UTC is 00:59 Nov 1
    expect(dayKey(Date.UTC(2026, 10, 1, 4, 59), "America/New_York")).toBe(
      "2026-11-01",
    );
    expect(dayKey(Date.UTC(2026, 10, 1, 3, 59), "America/New_York")).toBe(
      "2026-10-31",
    );
    // after fall back New York is UTC-5: 04:30 UTC Nov 2 is 23:30 Nov 1
    expect(dayKey(Date.UTC(2026, 10, 2, 4, 30), "America/New_York")).toBe(
      "2026-11-01",
    );
  });
});

describe("calendar arithmetic", () => {
  it("moves across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
  it("clamps months to their last day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });
  it("builds whole Sunday-first weeks covering the month", () => {
    const g = monthGrid("2026-10-10");
    expect(g[0]![0]).toBe("2026-09-27"); // Oct 1 2026 is a Thursday
    expect(g.at(-1)!.at(-1)).toBe("2026-10-31");
    expect(g).toHaveLength(5);
    expect(g.every((w) => w.length === 7)).toBe(true);
    // Feb 2026 starts on Sunday and ends on Saturday: exactly 4 weeks
    expect(monthGrid("2026-02-14")).toHaveLength(4);
  });
  it("formats a day without shifting it into the browser zone", () => {
    expect(fmtDay("2026-10-10")).toBe("Saturday, October 10");
  });
  it("finds the nearest day with posts", () => {
    const days = ["2026-10-01", "2026-10-14", "2026-10-20"];
    expect(nearestDay(days, "2026-10-10", 1)).toBe("2026-10-14");
    expect(nearestDay(days, "2026-10-10", -1)).toBe("2026-10-01");
    expect(nearestDay(days, "2026-10-20", 1)).toBeUndefined();
  });
});

describe("bucketByDay", () => {
  it("groups platforms of one clip, keeps reviews out and sorts by time", () => {
    const tz = "America/New_York";
    const late = Date.UTC(2026, 9, 11, 3, 0); // Oct 10, 11pm New York
    const early = Date.UTC(2026, 9, 10, 14, 0); // Oct 10, 10am New York
    const days = bucketByDay(
      [
        entry({ key: "j:1:youtube", slotAt: late, status: "posted" }),
        entry({
          key: "j:1:tiktok",
          platform: "tiktok",
          slotAt: late,
          status: "failed",
        }),
        entry({ key: "j:2:youtube", n: 2, slotAt: early }),
        entry({ key: "j:3:youtube", n: 3, slotAt: early, status: "review" }),
        entry({ key: "j:4:youtube", n: 4, slotAt: early, status: "rejected" }),
      ],
      tz,
    );
    expect([...days.keys()]).toEqual(["2026-10-10"]);
    const posts = days.get("2026-10-10")!;
    expect(posts.map((p) => p.group)).toEqual(["j:2", "j:1"]);
    expect(posts[1]!.entries).toHaveLength(2);
    expect(posts[1]!.kind).toBe("attention");
    expect(countKinds(posts)).toEqual({
      posted: 0,
      scheduled: 1,
      attention: 1,
    });
  });
  it("puts a posted clip on the day YouTube made it live", () => {
    const e = entry({
      status: "posted",
      slotAt: Date.UTC(2026, 9, 9, 12),
      delivery: {
        publishedAt: Date.UTC(2026, 9, 12, 12),
      } as QueueEntry["delivery"],
    });
    expect(entryTime(e)).toBe(Date.UTC(2026, 9, 12, 12));
    expect(entryKind(e)).toBe("posted");
  });
});

describe("thumbnails and results", () => {
  it("uses the first entry with a picture", () => {
    expect(postThumb([entry({}), entry({ thumbUrl: "/t.jpg" })])).toBe(
      "/t.jpg",
    );
  });
  it("matches results by delivery record or YouTube id", () => {
    const pub = (id: string, remoteId?: string) =>
      ({ key: id, remoteId, delivery: { id } }) as PerformancePublication;
    const pubs = [pub("d1", "v1"), pub("d2", "v2"), pub("d3")];
    expect(
      publicationsFor(
        [entry({ delivery: { id: "d3" } as QueueEntry["delivery"] })],
        pubs,
      ).map((p) => p.key),
    ).toEqual(["d3"]);
    expect(
      publicationsFor([entry({ result: { id: "v2" } })], pubs).map(
        (p) => p.key,
      ),
    ).toEqual(["d2"]);
    expect(publicationsFor([entry({})], pubs)).toEqual([]);
  });
  it("explains missing numbers and keeps older values", () => {
    expect(
      missingReason({
        availability: "unavailable",
        reason: "not-refreshed",
        metric: "views",
        checkedAt: 0,
      }),
    ).toBe("Not checked yet");
    expect(
      metricValue({
        availability: "unavailable",
        reason: "expired",
        metric: "views",
        checkedAt: 0,
        lastAvailable: {
          availability: "available",
          value: 42,
          metric: "views",
          unit: "count",
          source: "youtube-data",
          measuredAt: 0,
          window: { kind: "lifetime" },
          definitionVersion: "1",
        },
      }),
    ).toEqual({ value: 42, unit: "count", stale: true });
  });
});
