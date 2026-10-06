import { describe, expect, it } from "vitest";
import { hasScopes, isoDuration, parseAnalytics, parseMyChannel, parseVideoItems, quotaOrScope } from "../src/youtube-api";

describe("youtube data api parsing", () => {
  it("reads ISO 8601 durations", () => {
    expect(isoDuration("PT59S")).toBe(59);
    expect(isoDuration("PT1M4S")).toBe(64);
    expect(isoDuration("PT2H3M")).toBe(7380);
    expect(isoDuration("P1DT1S")).toBe(86401);
    expect(isoDuration("junk")).toBe(0);
  });

  it("reads my channel", () => {
    const c = parseMyChannel({
      items: [
        {
          id: "UC1",
          snippet: { title: "Pip & Lulu", customUrl: "@piplulu", description: "Stories", thumbnails: { default: { url: "d" }, high: { url: "h" } } },
          statistics: { subscriberCount: "120", viewCount: "4500", videoCount: "12", hiddenSubscriberCount: false },
          contentDetails: { relatedPlaylists: { uploads: "UU1" } },
          brandingSettings: { channel: { keywords: 'bedtime "kids stories" toddlers' } },
        },
      ],
    });
    expect(c).toMatchObject({ id: "UC1", title: "Pip & Lulu", handle: "@piplulu", avatar: "h", subscribers: 120, views: 4500, videos: 12, uploads: "UU1", keywords: ["bedtime", "kids stories", "toddlers"] });
    expect(parseMyChannel({ items: [] })).toBeNull();
  });

  it("reads videos (missing stats are undefined, not zero)", () => {
    const [v] = parseVideoItems({
      items: [
        {
          id: "v1",
          snippet: { title: "T", description: "D", tags: ["a"], publishedAt: "2026-10-01T10:00:00Z", categoryId: "22", thumbnails: { medium: { url: "m" } } },
          statistics: { viewCount: "10", likeCount: "2" },
          contentDetails: { duration: "PT45S" },
          status: { privacyStatus: "public", madeForKids: true },
        },
      ],
    });
    expect(v).toMatchObject({ id: "v1", title: "T", tags: ["a"], duration: 45, views: 10, likes: 2, thumb: "m", madeForKids: true, privacy: "public", categoryId: "22" });
    expect(v!.comments).toBeUndefined();
    expect(v!.publishedAt).toBe(Date.parse("2026-10-01T10:00:00Z"));
  });

  it("turns analytics rows into objects by column name", () => {
    expect(
      parseAnalytics({
        columnHeaders: [{ name: "day" }, { name: "views" }, { name: "estimatedMinutesWatched" }],
        rows: [
          ["2026-10-01", 5, 3.5],
          ["2026-10-02", 7, 4],
        ],
      }),
    ).toEqual([
      { day: "2026-10-01", views: 5, estimatedMinutesWatched: 3.5 },
      { day: "2026-10-02", views: 7, estimatedMinutesWatched: 4 },
    ]);
    expect(parseAnalytics({})).toEqual([]);
  });

  it("knows which permissions a token has", () => {
    const s = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
    expect(hasScopes(s)).toEqual({ read: true, analytics: false, edit: false });
    expect(hasScopes(`${s} https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.force-ssl`)).toEqual({ read: true, analytics: true, edit: true });
    expect(hasScopes(undefined)).toEqual({ read: false, analytics: false, edit: false });
  });

  it("explains quota and permission refusals", () => {
    expect(quotaOrScope(403, { error: { message: "x", errors: [{ reason: "quotaExceeded" }] } })).toMatch(/daily limit/);
    expect(quotaOrScope(403, { error: { message: "x", errors: [{ reason: "insufficientPermissions" }] } })).toMatch(/Reconnect YouTube/);
    expect(quotaOrScope(403, { error: { message: "YouTube Analytics API has not been used in project 1 before or it is disabled.", errors: [{ reason: "accessNotConfigured" }] } })).toMatch(/Enable the YouTube Analytics API/);
    expect(quotaOrScope(500, { error: { message: "boom" } })).toBeNull();
  });
});
