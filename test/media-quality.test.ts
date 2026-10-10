import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/exec";
import { checkMedia } from "../server/media-quality";
import type { RenderArtifact } from "../lib/studio/types";
import { createHash } from "node:crypto";
let root: string;
const artifact = (name: string): RenderArtifact => ({
  id: name,
  projectId: "fixture",
  revision: 1,
  checksum: createHash("sha256")
    .update(readFileSync(path.join(root, name)))
    .digest("hex"),
  path: path.join(root, name),
  probe: {
    durationUs: 1000000,
    width: 160,
    height: 284,
    fps: { numerator: 30, denominator: 1 },
    hasAudio: true,
  },
  renderer: "ffmpeg",
  rendererVersion: "fixture",
  reviewIds: [],
});
beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "capy-c3-quality-"));
  for (const [name, video, audio] of [
    ["good.mp4", "testsrc2=size=160x284:rate=30", "sine=frequency=440"],
    ["black.mp4", "color=c=black:size=160x284:rate=30", "sine=frequency=440"],
    ["silent.mp4", "testsrc2=size=160x284:rate=30", "anullsrc"],
    ["wide.mp4", "testsrc2=size=284x160:rate=30", "sine=frequency=440"],
  ])
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      video!,
      "-f",
      "lavfi",
      "-i",
      audio!,
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      path.join(root, name!),
    ]);
  const good = readFileSync(path.join(root, "good.mp4"));
  writeFileSync(
    path.join(root, "truncated.mp4"),
    good.subarray(0, Math.floor(good.length / 2)),
  );
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x284:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x284:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x284:r=30:d=1",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    path.join(root, "freeze-tail.mp4"),
  ]);
}, 30000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe("deterministic real media quality", () => {
  it("counts a final frozen interval after an earlier interval already ended", async () => {
    const a = artifact("freeze-tail.mp4");
    a.probe.durationUs = 3000000;
    const r = await checkMedia(a, { maxFrozenRatio: 0.5 });
    expect(r.checks.find((c) => c.id === "frozen")?.pass).toBe(false);
  });
  it("quality_catches_real_bad_media decode, silence, black, aspect and caption overflow", async () => {
    for (const [file, id] of [
      ["truncated.mp4", "decode"],
      ["silent.mp4", "audio"],
      ["black.mp4", "black"],
      ["wide.mp4", "aspect"],
    ]) {
      const r = await checkMedia(artifact(file!), {
        requireAudio: true,
        aspect: "portrait",
      });
      expect(r.checks.find((c) => c.id === id)?.pass).toBe(false);
      expect(r.passed).toBe(false);
    }
    const r = await checkMedia(artifact("good.mp4"), {
      aspect: "portrait",
      captions: [{ x: 150, y: 20, width: 80, height: 50 }],
    });
    expect(r.checks.find((c) => c.id === "captions")?.pass).toBe(false);
  });
  it("actual subtitle raster outside safe margins fails caption check", async () => {
    const ass = path.join(root, "overflow.ass");
    writeFileSync(
      ass,
      "[Script Info]\nScriptType: v4.00+\nPlayResX: 160\nPlayResY: 284\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,BackColour,Bold,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H00000000,0,7,0,0,0,1\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,{\\pos(0,0)}OUTSIDE",
    );
    const r = await checkMedia(artifact("good.mp4"), {
      captionOverlayPath: ass,
    });
    expect(r.checks.find((c) => c.id === "captions")?.pass).toBe(false);
  });
  it("speech/face-free real footage passes; silent footage can be explicitly allowed; unavailable supplementary review is never pass", async () => {
    expect(
      (
        await checkMedia(artifact("good.mp4"), {
          requireAudio: true,
          aspect: "portrait",
        })
      ).passed,
    ).toBe(true);
    expect(
      (
        await checkMedia(artifact("silent.mp4"), {
          requireAudio: false,
          aspect: "portrait",
        })
      ).passed,
    ).toBe(true);
    const review = await checkMedia(artifact("good.mp4"), {
      requireModelReview: true,
    });
    expect(review.passed).toBe(false);
    expect(review.modelReview.status).toBe("unavailable");
  });
});
