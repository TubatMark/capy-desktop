import { mapSources } from "../lib/studio/operations";
import { beforeAll, expect, it } from "vitest";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { run } from "../src/exec";
import {
  compileNormalizedProject,
  renderNormalizedProject,
  probeMedia,
} from "../src/studio/ffmpeg-adapter";
import { retimeItem, freezeItem } from "../lib/studio/retiming";
import { applyTemplate } from "../lib/studio/templates";
import { project } from "./fixtures/studio-advanced";
import type { AssetRef, ProjectDocument } from "../lib/studio/types";
const root = process.env.CAPY_B7_EVIDENCE_DIR ?? "/tmp/capy-b7-render-evidence";
let asset: AssetRef;
beforeAll(async () => {
  await mkdir(root, { recursive: true });
  const source = path.join(root, "source.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x240:r=30:d=4,drawbox=x=20:y=40:w=50:h=80:color=white:t=fill,drawbox=x=200:y=80:w=30:h=40:color=blue:t=fill,drawtext=text='%{n}':x=130:y=30:fontsize=20:fontcolor=white",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    source,
  ]);
  asset = {
    id: "asset",
    kind: "video",
    location: source,
    status: "ready",
    durationUs: 4000000,
    checksum: createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
    streams: [
      { kind: "video", codec: "h264" },
      { kind: "audio", codec: "aac" },
    ],
  };
});
async function render(doc: ProjectDocument, name: string) {
  const plan = await compileNormalizedProject(doc, [asset]);
  return renderNormalizedProject(
    plan,
    new AbortController().signal,
    path.join(root, name),
  );
}
async function pcm(file: string, name: string) {
  const target = path.join(root, name + ".f32");
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "f32le",
    "-y",
    target,
  ]);
  return readFile(target);
}
async function frame(file: string, time: number, name: string) {
  const target = path.join(root, name + ".rgb");
  await run("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(time),
    "-i",
    file,
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "-y",
    target,
  ]);
  return readFile(target);
}
it("actual speed output preserves 440 Hz pitch, duration and source word mapping", async () => {
  for (const speed of [0.5, 2]) {
    const doc = retimeItem(project(), "a", speed).document,
      out = await render(doc, `speed-${speed}`),
      probe = await probeMedia(out.path);
    expect(Number(probe.format.duration)).toBeCloseTo(4 / speed, 1);
    expect(doc.captionCues[0]!.startFrame).toBe(30 / speed);
    const samples = await pcm(out.path, `speed-${speed}`);
    let crossings = 0;
    for (let n = 24001; n < 48000; n++)
      if (
        samples.readFloatLE((n - 1) * 4) <= 0 &&
        samples.readFloatLE(n * 4) > 0
      )
        crossings++;
    expect(crossings * 2).toBeGreaterThan(430);
    expect(crossings * 2).toBeLessThan(450);
    const actual = await frame(out.path, 1, `marker-output-${speed}`),
      expected = await frame(asset.location, speed, `marker-source-${speed}`),
      wrong = await frame(asset.location, 1, `marker-wrong-${speed}`);
    const patchError = (a: Buffer, b: Buffer) => {
      let error = 0,
        count = 0;
      for (let y = 25; y < 60; y++)
        for (let x = 125; x < 175; x++)
          for (let c = 0; c < 3; c++) {
            const n = (y * 320 + x) * 3 + c;
            error += Math.abs(a[n]! - b[n]!);
            count++;
          }
      return error / count;
    };
    expect(patchError(actual, expected)).toBeLessThan(5);
    expect(patchError(actual, wrong)).toBeGreaterThan(
      patchError(actual, expected) + 1,
    );
  }
}, 30000);
it("actual freeze holds one image for explicit duration and silent audio", async () => {
  const doc = freezeItem(project(), "a", 45, 90, "silence").document;
  doc.captionCues = [];
  const out = await render(doc, "freeze");
  expect(out.probe.durationUs).toBe(3000000);
  const a = await frame(out.path, 0.5, "freeze-early"),
    b = await frame(out.path, 2.5, "freeze-late");
  let error = 0;
  for (let n = 0; n < a.length; n++) error += Math.abs(a[n]! - b[n]!);
  expect(error / a.length).toBeLessThan(0.5);
  const samples = await pcm(out.path, "freeze");
  let peak = 0;
  for (let n = 0; n < samples.length; n += 4)
    peak = Math.max(peak, Math.abs(samples.readFloatLE(n)));
  expect(peak).toBeLessThan(0.0001);
}, 30000);
it("actual main and overlay keyframes render repeatable selected frames forward backward and direct", async () => {
  let doc = project();
  doc.captionCues = [];
  doc.items[0]!.keyframes = [
    { frame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
    { frame: 60, x: 30, y: 5, scale: 0.8, rotation: 12 },
    { frame: 119, x: 0, y: 0, scale: 1, rotation: 0 },
  ];
  doc = applyTemplate(doc, {
    id: "local-title",
    version: 1,
    instanceId: "callout",
    parameters: {
      text: "Motion",
      placement: "callout",
      startFrame: 0,
      durationFrames: 120,
      color: "#ffffff",
    },
  }).document;
  const out = await render(doc, "motion"),
    direct = await frame(out.path, 1, "motion-direct");
  await frame(out.path, 3, "motion-forward");
  await frame(out.path, 0, "motion-back");
  expect(await frame(out.path, 1, "motion-repeat")).toEqual(direct);
  const early = await frame(out.path, 0, "motion-early");
  expect(direct.equals(early)).toBe(false);
  const atKey = await frame(out.path, 2, "motion-key");
  const centroid = (pixels: Buffer) => {
    let x = 0,
      y = 0,
      count = 0;
    for (let n = 0; n < pixels.length; n += 3)
      if (pixels[n]! > 150 && pixels[n + 1]! < 80 && pixels[n + 2]! < 80) {
        x += (n / 3) % 320;
        y += Math.floor(n / 3 / 320);
        count++;
      }
    return { x: x / count, y: y / count, count };
  };
  const initial = centroid(early),
    key = centroid(atKey);
  expect(key.x - initial.x).toBeGreaterThan(20);
  expect(key.x - initial.x).toBeLessThan(40);
  expect(key.count / initial.count).toBeGreaterThan(0.55);
  expect(key.count / initial.count).toBeLessThan(0.7);
  const again = await render(doc, "motion-again");
  expect(await frame(again.path, 1, "motion-second-render")).toEqual(direct);
}, 30000);

it("retimed decoded speech marker aligns with remapped captions within one project frame", async () => {
  const file = path.join(root, "speech-marker.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    asset.location,
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=if(between(t\\,1\\,1.5)\\,0.5*sin(2*PI*440*t)\\,0):s=48000:d=4",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-y",
    file,
  ]);
  const marker = {
    ...asset,
    location: file,
    checksum: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  };
  for (const speed of [0.5, 2]) {
    const doc = retimeItem(project(), "a", speed).document,
      plan = await compileNormalizedProject(doc, [marker]),
      out = await renderNormalizedProject(
        plan,
        new AbortController().signal,
        path.join(root, `speech-${speed}`),
      );
    const samples = await pcm(out.path, `speech-${speed}`);
    let onset = 0;
    for (let n = 0; n < samples.length / 4; n += 240) {
      let power = 0;
      for (let k = n; k < Math.min(n + 240, samples.length / 4); k++)
        power += samples.readFloatLE(k * 4) ** 2;
      if (Math.sqrt(power / 240) > 0.025) {
        onset = n / 48000;
        break;
      }
    }
    expect(Math.abs(onset - doc.captionCues[0]!.startFrame / 30)).toBeLessThan(
      1 / 30,
    );
  }
}, 30000);

it("short and adjacent word boundaries preserve decoded content without changing the mix", async () => {
  for (const speed of [0.5, 2]) {
    let source = project();
    source.items[0]!.durationFrames = 6;
    source.items[0]!.sourceOutUs = 200000;
    source.sourceWords = [
      {
        assetId: "asset",
        words: Array.from({ length: 20 }, (_, i) => ({
          id: `short-${i}`,
          text: "word",
          startUs: i * 10000,
          endUs: Math.min(200000, i * 10000 + 15000),
        })),
      },
    ];
    source = mapSources(source);
    const doc = retimeItem(source, "a", speed).document;
    doc.captionCues = [];
    const result = await render(doc, `dense-words-${speed}`),
      samples = await pcm(result.path, `dense-words-${speed}`);
    for (let n = 240; n < Math.floor((0.2 / speed) * 48000) - 240; n += 240) {
      let power = 0;
      for (let k = n; k < n + 240; k++)
        power += samples.readFloatLE(k * 4) ** 2;
      expect(Math.sqrt(power / 240)).toBeGreaterThan(0.025);
    }
    const noWords = structuredClone(doc);
    noWords.sourceWords = [];
    noWords.captionCues = [];
    const plain = await render(noWords, `without-words-${speed}`);
    expect(await pcm(plain.path, `without-words-${speed}`)).toEqual(samples);
    const tiny = project();
    tiny.items[0]!.sourceInUs = 1000000;
    tiny.items[0]!.sourceOutUs = 1010000;
    tiny.items[0]!.durationFrames = 1;
    tiny.sourceWords = [];
    mapSources(tiny);
    const tinyDoc = retimeItem(tiny, "a", speed).document;
    const tinyRender = await render(tinyDoc, `ten-ms-${speed}`),
      tinyPcm = await pcm(tinyRender.path, `ten-ms-${speed}`);
    let energy = 0;
    const length = Math.floor((0.01 / speed) * 48000);
    for (let n = 0; n < length; n++) energy += tinyPcm.readFloatLE(n * 4) ** 2;
    expect(Math.sqrt(energy / length)).toBeGreaterThan(0.025);
  }
}, 30000);

it("sixty-second retimed speech markers have no cumulative timing drift", async () => {
  const file = path.join(root, "sixty-second-markers.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=160x90:r=30:d=60",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=if(between(mod(t\\,1)\\,0.5\\,0.75)\\,0.5*sin(2*PI*440*t)\\,0):s=48000:d=60",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    file,
  ]);
  const marker = {
    ...asset,
    location: file,
    durationUs: 60000000,
    checksum: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  };
  for (const speed of [0.5, 2]) {
    const source = project();
    source.canvas = { width: 160, height: 90 };
    source.items[0]!.durationFrames = 1800;
    source.items[0]!.sourceOutUs = 60000000;
    source.sourceWords = [
      {
        assetId: "asset",
        words: Array.from({ length: 60 }, (_, i) => ({
          id: `marker-${i}`,
          text: "beat",
          startUs: (i + 0.5) * 1e6,
          endUs: (i + 0.75) * 1e6,
        })),
      },
    ];
    mapSources(source);
    const doc = retimeItem(source, "a", speed).document,
      plan = await compileNormalizedProject(doc, [marker]),
      out = await renderNormalizedProject(
        plan,
        new AbortController().signal,
        path.join(root, `sixty-${speed}`),
      );
    expect(out.probe.durationUs).toBe(60000000 / speed);
    const samples = await pcm(out.path, `sixty-${speed}`),
      onsets: number[] = [];
    let active = false;
    for (let n = 0; n + 240 < samples.length / 4; n += 240) {
      let power = 0;
      for (let k = n; k < n + 240; k++)
        power += samples.readFloatLE(k * 4) ** 2;
      const signal = Math.sqrt(power / 240) > 0.025;
      if (
        signal &&
        !active &&
        (!onsets.length || n / 48000 - onsets.at(-1)! > 0.5 / speed)
      )
        onsets.push(n / 48000);
      active = signal;
    }
    expect(onsets).toHaveLength(60);
    for (let n = 0; n < 60; n++)
      expect(Math.abs(onsets[n]! - (n + 0.5) / speed)).toBeLessThan(1 / 30);
    expect(doc.captionCues.map((c) => c.startFrame)).toEqual(
      Array.from({ length: 60 }, (_, i) => ((i + 0.5) * 30) / speed).map(
        Math.round,
      ),
    );
  }
}, 90000);

it("stretched stereo stays coherent and preserves low and high pitch", async () => {
  for (const frequency of [80, 1000]) {
    const file = path.join(root, `stereo-phase-${frequency}.mp4`);
    await run("ffmpeg", [
      "-v",
      "error",
      "-i",
      asset.location,
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=0.4*sin(2*PI*${frequency}*t)|-0.4*sin(2*PI*${frequency}*t):s=48000:d=4`,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-y",
      file,
    ]);
    const stereo = {
      ...asset,
      location: file,
      checksum: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    };
    for (const speed of [0.5, 2]) {
      const doc = retimeItem(project(), "a", speed).document,
        plan = await compileNormalizedProject(doc, [stereo]),
        out = await renderNormalizedProject(
          plan,
          new AbortController().signal,
          path.join(root, `stereo-${frequency}-${speed}`),
        );
      const raw = path.join(root, `stereo-${frequency}-${speed}.f32`);
      await run("ffmpeg", [
        "-v",
        "error",
        "-i",
        out.path,
        "-vn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "-y",
        raw,
      ]);
      const samples = await readFile(raw);
      let leftPower = 0,
        rightPower = 0,
        dot = 0,
        crossings = 0;
      for (let n = 24000; n < 72000; n++) {
        const left = samples.readFloatLE(n * 8),
          right = samples.readFloatLE(n * 8 + 4);
        expect(Number.isFinite(left) && Number.isFinite(right)).toBe(true);
        leftPower += left * left;
        rightPower += right * right;
        dot += left * right;
        if (samples.readFloatLE((n - 1) * 8) <= 0 && left > 0) crossings++;
      }
      expect(Math.sqrt(leftPower / 48000)).toBeGreaterThan(0.2);
      expect(Math.sqrt(rightPower / 48000)).toBeGreaterThan(0.2);
      expect(dot / Math.sqrt(leftPower * rightPower)).toBeLessThan(-0.98);
      expect(crossings).toBeGreaterThanOrEqual(frequency * 0.97);
      expect(crossings).toBeLessThanOrEqual(frequency * 1.03);
    }
  }
}, 30000);

it("cancels during streamed tempo processing and removes partial artifacts", async () => {
  const doc = retimeItem(project(), "a", 0.5).document;
  const plan = await compileNormalizedProject(doc, [asset]);
  const controller = new AbortController();
  const dir = path.join(root, "cancel-tempo");
  let settled = false,
    cancelledDuringTempo = false;
  const result = renderNormalizedProject(plan, controller.signal, dir)
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      settled = true;
    });
  while (!settled) {
    const size = await stat(path.join(dir, "tempo-1.f32")).then(
      (s) => s.size,
      () => 0,
    );
    if (size > 0) {
      cancelledDuringTempo = true;
      controller.abort();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(await result).toMatchObject({ name: "CancelledError" });
  expect(cancelledDuringTempo).toBe(true);
  expect(
    await stat(dir).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
}, 30000);
