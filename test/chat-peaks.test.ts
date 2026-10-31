import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bucketChat, chatPeaks, readChatFile } from "../src/chat-peaks";
vi.mock("../src/agents", () => ({ askAgent: vi.fn() }));

const spread = (n: number, at: number) => Array.from({ length: n }, (_, i) => at * 1000 + i);

describe("live chat peaks", () => {
  it("finds where chat went off", () => {
    const quiet = Array.from({ length: 60 }, (_, b) => spread(3, b * 20)).flat();
    const peaks = chatPeaks(bucketChat([...quiet, ...spread(80, 400), ...spread(70, 800)]));
    expect(peaks.map((p) => p.start).sort((a, b) => a - b)).toEqual([400, 800]);
  });
  it("gives nothing when chat is too quiet to mean anything", () => {
    expect(bucketChat(spread(50, 10))).toEqual([]);
    expect(bucketChat(Array.from({ length: 30 }, (_, b) => b * 20_000))).toEqual([]);
  });
  it("reads yt-dlp's chat replay file and skips lines with no time", async () => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), "capy-chat-")), "c.json");
    const lines = Array.from({ length: 40 }, (_, b) => Array.from({ length: 8 }, () => `{"replayChatItemAction": {}, "videoOffsetTimeMsec": "${b * 20_000}"}`)).flat();
    writeFileSync(f, ["{not chat}", ...lines].join("\n"));
    expect(await readChatFile(f)).toHaveLength(40);
  });
});
