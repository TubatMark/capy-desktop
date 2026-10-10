import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/exec";
import { checksum } from "../server/studio/assets";
import { extractFrameCandidates } from "../src/thumbnails/frames";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function source(filter: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "capy-thumb-frames-"));
  dirs.push(dir);
  const file = path.join(dir, "fixture.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    filter,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    file,
  ]);
  return {
    kind: "legacy" as const,
    clipId: "job:1",
    revision: 7,
    assetId: "original",
    path: file,
    checksum: await checksum(file),
    sourceOffsetUs: 8_000_000,
  };
}
it("candidate_frames_are_distinct_and_traceable without faces", async () => {
  const input = await source("testsrc2=size=320x180:rate=12:duration=6");
  const frames = await extractFrameCandidates(
    input,
    new AbortController().signal,
    { directory: path.dirname(input.path) },
  );
  expect(frames.length).toBeGreaterThanOrEqual(8);
  expect(frames.length).toBeLessThanOrEqual(12);
  expect(new Set(frames.map((f) => f.checksum)).size).toBe(frames.length);
  for (const frame of frames) {
    expect(frame.sourceUs).toBe(frame.renderUs + 8_000_000);
    expect(frame.sourceRevision).toBe(7);
    expect(frame.renderChecksum).toBe(input.checksum);
    expect(frame.quality.status).toBe("usable");
  }
}, 90_000);
it("black frozen footage offers an explicit fallback and manual selector", async () => {
  const input = await source("color=black:size=320x180:rate=2:duration=2");
  const frames = await extractFrameCandidates(
    input,
    new AbortController().signal,
    { directory: path.dirname(input.path) },
  );
  expect(frames).toHaveLength(1);
  expect(frames[0]!.quality.status).toBe("fallback");
  expect(frames[0]!.quality.reason).toMatch(/manual/i);
}, 90_000);
it("rejects changed media and aborts extraction", async () => {
  const input = await source("testsrc2=size=160x90:rate=2:duration=1");
  await expect(
    extractFrameCandidates(
      { ...input, checksum: "changed" },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/checksum/i);
  const controller = new AbortController();
  controller.abort();
  await expect(
    extractFrameCandidates(input, controller.signal),
  ).rejects.toThrow(/cancel|abort/i);
}, 30_000);
it("excludes black scenes without padding a short distinct shortlist with duplicates", async () => {
  const input = await source(
    "color=black:size=320x180:rate=6:duration=1[a];testsrc2=size=320x180:rate=6:duration=2[b];[a][b]concat=n=2:v=1:a=0",
  );
  const frames = await extractFrameCandidates(
    input,
    new AbortController().signal,
    { directory: path.dirname(input.path) },
  );
  expect(frames.length).toBeGreaterThan(1);
  expect(
    frames.every(
      (frame) =>
        frame.quality.status === "usable" && frame.renderUs >= 1_000_000,
    ),
  ).toBe(true);
}, 90_000);
