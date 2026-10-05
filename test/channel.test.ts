import { describe, expect, it } from "vitest";
import { channelVideosUrl, parseChannel, parseUploads } from "../src/youtube";

describe("channelVideosUrl", () => {
  it.each([
    ["@canalgnt", "https://www.youtube.com/@canalgnt/videos"],
    ["https://www.youtube.com/@canalgnt", "https://www.youtube.com/@canalgnt/videos"],
    ["https://youtube.com/@canalgnt/shorts", "https://www.youtube.com/@canalgnt/videos"],
    ["https://www.youtube.com/channel/UC0f866RMRdL5mSVnipiOHxg", "https://www.youtube.com/channel/UC0f866RMRdL5mSVnipiOHxg/videos"],
    ["https://www.youtube.com/c/SomeName/featured", "https://www.youtube.com/c/SomeName/videos"],
    ["https://www.youtube.com/user/oldname", "https://www.youtube.com/user/oldname/videos"],
    ["UC0f866RMRdL5mSVnipiOHxg", "https://www.youtube.com/channel/UC0f866RMRdL5mSVnipiOHxg/videos"],
  ])("%s", (input, want) => expect(channelVideosUrl(input)).toBe(want));
  it("returns null for video links and junk (those are resolved through the video's channel)", () => {
    expect(channelVideosUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(channelVideosUrl("hello world")).toBeNull();
  });
});

const listing = {
  channel: "Canal GNT",
  channel_id: "UC0f866RMRdL5mSVnipiOHxg",
  uploader_id: "@canalgnt",
  entries: [
    { id: "WAcqBlVUrwY", title: "Friendship", duration: 246, live_status: null },
    { id: "liveNow0001", title: "Live", duration: null, live_status: "is_live" },
    { id: "upcoming001", title: "Soon", duration: null, live_status: "is_upcoming" },
    { id: "premiere001", title: "No length yet", duration: null, live_status: null },
  ],
};

describe("parseChannel / parseUploads", () => {
  it("reads the channel identity", () => {
    expect(parseChannel(listing)).toEqual({ id: "UC0f866RMRdL5mSVnipiOHxg", name: "Canal GNT", handle: "@canalgnt", url: "https://www.youtube.com/channel/UC0f866RMRdL5mSVnipiOHxg/videos" });
  });
  it("lists uploads newest first, flagging live/upcoming", () => {
    expect(parseUploads(listing)).toEqual([
      { id: "WAcqBlVUrwY", title: "Friendship", duration: 246, live: false },
      { id: "liveNow0001", title: "Live", duration: undefined, live: true },
      { id: "upcoming001", title: "Soon", duration: undefined, live: true },
      { id: "premiere001", title: "No length yet", duration: undefined, live: false },
    ]);
  });
  it("tolerates a missing entries list", () => {
    expect(parseUploads({})).toEqual([]);
  });
});
