import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { run } from "../src/exec";
import {
  compileNormalizedProject,
  renderNormalizedProject,
} from "../src/studio/ffmpeg-adapter";
import type { AssetRef, ProjectDocument } from "../lib/studio/types";
let dir: string, asset: AssetRef;
const doc: ProjectDocument = {
  schemaVersion: 1,
  id: "render-fixture",
  revision: 1,
  canvas: { width: 160, height: 90 },
  fps: { numerator: 30, denominator: 1 },
  tracks: [{ id: "v", kind: "video" }],
  items: [
    {
      id: "v1",
      trackId: "v",
      assetId: "a",
      startFrame: 0,
      durationFrames: 60,
      sourceInUs: 0,
      sourceOutUs: 2000000,
      speed: 1,
    },
  ],
  sourceMappings: [
    { itemId: "v1", assetId: "a", sourceInUs: 0, sourceOutUs: 2000000 },
  ],
  captionCues: [
    {
      id: "caption",
      startFrame: 15,
      durationFrames: 30,
      text: "Real export",
      fontSize: 18,
    },
  ],
  thumbnailIds: [],
};
beforeAll(async () => {
  dir =
    process.env.CAPY_RENDER_EVIDENCE_DIR ??
    (await mkdtemp(path.join(os.tmpdir(), "capy-render-test-")));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "source.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=160x90:r=24:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=44100:duration=2",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    file,
  ]);
  asset = {
    id: "a",
    kind: "video",
    location: file,
    checksum: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
    status: "ready",
    durationUs: 2000000,
    streams: [
      { kind: "video", codec: "h264" },
      { kind: "audio", codec: "aac", sampleRate: 44100 },
    ],
  };
});
afterAll(async () => {
  if (!process.env.CAPY_RENDER_EVIDENCE_DIR)
    await rm(dir, { recursive: true, force: true });
});
test("mixed_media_export_matches_preview: normalized captions and actual source audio", async () => {
  const plan = await compileNormalizedProject(doc, [asset]);
  const out = await renderNormalizedProject(
    plan,
    new AbortController().signal,
    path.join(dir, "output"),
  );
  expect(out.revision).toBe(1);
  expect(out.probe).toMatchObject({
    width: 160,
    height: 90,
    durationUs: 2000000,
    hasAudio: true,
  });
  const p = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-of",
        "json",
        out.path,
      ])
    ).stdout,
  );
  expect(
    p.streams.find((s: any) => s.codec_type === "video").nb_read_frames,
  ).toBe("60");
  expect(p.streams.find((s: any) => s.codec_type === "audio").sample_rate).toBe(
    "48000",
  );
  expect(out.normalizationPolicy).toContain("sdr");
}, 30000);
test("checksum mismatch and cancellation never produce artifacts", async () => {
  await expect(
    compileNormalizedProject(doc, [{ ...asset, checksum: "changed" }]),
  ).rejects.toThrow("checksum");
  const plan = await compileNormalizedProject(doc, [asset]);
  const abort = new AbortController();
  abort.abort();
  await expect(
    renderNormalizedProject(plan, abort.signal, path.join(dir, "cancel")),
  ).rejects.toThrow("Cancelled");
});

import { Store } from "../server/db";
import { WorkQueue } from "../server/worker/leases";
import { runJob } from "../server/worker/runner";
import {
  requestProjectRender,
  studioRenderStages,
  resolveRender,
} from "../server/studio/render";

test("old_render_cannot_overwrite_new_revision; presets have separate work identity and cancelled work preserves artifacts", async () => {
  const store = new Store(path.join(dir, "worker.sqlite")),
    q = new WorkQueue(store, { leaseMs: 60000 });
  const deps = { store, root: dir, enqueue: (input: any) => q.enqueue(input) };
  try {
    store.put("projects", doc.id, doc);
    store.put("project-history", `${doc.id}:1`, doc);
    store.put("assets", asset.id, asset);
    const job = await requestProjectRender(
      doc.id,
      1,
      { aspect: "project", fps: 30, codec: "h264-aac" },
      deps,
    );
    const duplicate = await requestProjectRender(
      doc.id,
      1,
      { aspect: "project", fps: 30, codec: "h264-aac" },
      deps,
    );
    expect(duplicate.id).toBe(job.id);
    const other = await requestProjectRender(
      doc.id,
      1,
      { aspect: "square", fps: 30, codec: "h264-aac" },
      deps,
    );
    expect(other.id).not.toBe(job.id);
    await q.cancel(other.id);
    const lease = (await q.claim("test-worker"))!;
    expect(lease.id).toBe(job.id);
    store.put("projects", doc.id, {
      ...doc,
      revision: 2,
      captionCues: [{ ...doc.captionCues[0]!, text: "edited" }],
    });
    await runJob(lease, new AbortController().signal, {
      queue: q,
      stages: studioRenderStages(deps),
      artifactRoot: dir,
    });
    expect(q.get(job.id)?.status).toBe("complete");
    const artifacts = store.list<any>("renders");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.value.revision).toBe(1);
    expect(store.get<any>("projects", doc.id)?.value.revision).toBe(2);
    expect(
      (
        await resolveRender(
          doc.id,
          artifacts[0]!.id,
          artifacts[0]!.value.checksum,
          deps,
        )
      ).id,
    ).toBe(artifacts[0]!.id);
    expect(q.get(other.id)?.status).toBe("cancelled");
    expect(store.list("renders")).toHaveLength(1);
  } finally {
    store.close();
  }
}, 30000);

import {
  syntheticStudio,
  toneAmplitude,
} from "./fixtures/renderer/studio-fixture";
import { writeFile } from "node:fs/promises";
async function pcm(file: string, name: string) {
  const target = path.join(dir, `${name}.f32`);
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:a",
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
async function rgb(file: string, frame: number) {
  const target = path.join(dir, `rgb-${frame}.raw`);
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `select=eq(n\\,${frame}),scale=1:1`,
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "-y",
    target,
  ]);
  return [...(await readFile(target))];
}
test("mixed_media_export_matches_preview: real 60s full-HD mixed-fps rotation silence and 44.1/48k audio stays within one frame", async () => {
  const fixture = await syntheticStudio(path.join(dir, "mixed"), "mixed60");
  const start = Date.now();
  const plan = await compileNormalizedProject(
    fixture.document,
    fixture.assets,
    { aspect: "portrait", fps: 30, codec: "h264-aac" },
  );
  const out = await renderNormalizedProject(
    plan,
    new AbortController().signal,
    path.join(dir, "mixed-output"),
  );
  expect(out.probe).toMatchObject({
    width: 1080,
    height: 1920,
    durationUs: 60e6,
    hasAudio: true,
  });
  expect(plan.audio.clips.find((c) => c.assetId === "v1")).toBeUndefined();
  const decoded = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        out.path,
      ])
    ).stdout,
  ).frames;
  expect(decoded).toHaveLength(1800);
  decoded.forEach((f: any, index: number) =>
    expect(
      Math.abs(Number(f.best_effort_timestamp_time) - index / 30),
    ).toBeLessThan(0.000002),
  );
  const outputProbe = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        out.path,
      ])
    ).stdout,
  ).streams;
  expect(outputProbe.find((s: any) => s.codec_type === "video")).toMatchObject({
    codec_name: "h264",
    color_space: "bt709",
    color_transfer: "bt709",
    avg_frame_rate: "30/1",
  });
  expect(outputProbe.find((s: any) => s.codec_type === "audio")).toMatchObject({
    codec_name: "aac",
    sample_rate: "48000",
    channels: 2,
  });
  const audio = await pcm(out.path, "mixed");
  const markers = [];
  for (const expected of [0.2, 14.2, 29.2, 44.2, 59.2]) {
    let peak = 0,
      at = 0;
    for (let t = expected - 0.04; t < expected + 0.14; t += 0.01) {
      const amp = toneAmplitude(audio, t, 0.01, 3000);
      if (amp > peak) {
        peak = amp;
        at = t;
      }
    }
    expect(peak).toBeGreaterThan(0.12);
    let onset = expected - 0.04;
    while (
      onset < expected + 0.12 &&
      toneAmplitude(audio, onset, 0.005, 3000) < peak * 0.35
    )
      onset += 0.005;
    expect(Math.abs(onset - expected)).toBeLessThanOrEqual(1 / 30);
    markers.push({ expected, onset, peak, peakAt: at });
  }
  const reference = [];
  for (const [frame, channel] of [
    [449, 0],
    [480, 1],
    [900, 2],
    [1350, 0],
  ] as const) {
    const color = await rgb(out.path, frame);
    expect(color[channel]).toBeGreaterThan(frame === 480 ? 100 : 20);
    reference.push({ frame, color });
  }
  const evidence = {
    artifact: out,
    elapsedMs: Date.now() - start,
    markers,
    reference,
    frameCount: plan.frameCount,
  };
  await writeFile(
    path.join(dir, "mixed-evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("B4 mixed60 evidence", JSON.stringify(evidence));
}, 180000);
test("B1 rich30 closure: two crossfades, captions/text and measured 12dB canonical music ducking", async () => {
  const fixture = await syntheticStudio(path.join(dir, "rich"), "rich30");
  const plan = await compileNormalizedProject(fixture.document, fixture.assets);
  const out = await renderNormalizedProject(
    plan,
    new AbortController().signal,
    path.join(dir, "rich-output"),
  );
  expect(plan.frameCount).toBe(900);
  const audio = await pcm(out.path, "rich");
  const before = toneAmplitude(audio, 5, 1, 220),
    during = toneAmplitude(audio, 12, 1, 220),
    after = toneAmplitude(audio, 20, 1, 220),
    duckDb = 20 * Math.log10(during / before);
  expect(duckDb).toBeCloseTo(-12, 0);
  expect(after / before).toBeCloseTo(1, 1);
  expect(toneAmplitude(audio, 10.05, 0.1, 1000)).toBeGreaterThan(0.025);
  expect(toneAmplitude(audio, 9.9, 0.05, 1000)).toBeLessThan(0.003);
  expect(toneAmplitude(audio, 15.05, 0.05, 1000)).toBeLessThan(0.003);
  // Independent linear-gain expectation, measured in 50 ms / 11-cycle windows.
  // An abrupt duck or release would miss these intermediate amplitudes.
  const target = 10 ** (-12 / 20);
  const ramps = [
    { start: 9.9, expected: 1 - (1 - target) * 0.25 },
    { start: 9.95, expected: 1 - (1 - target) * 0.75 },
    { start: 15, expected: target + (1 - target) / 12 },
    { start: 15.125, expected: target + (1 - target) * 0.5 },
    { start: 15.25, expected: target + ((1 - target) * 11) / 12 },
  ].map((point) => ({
    ...point,
    actual: toneAmplitude(audio, point.start, 0.05, 220) / before,
  }));
  for (const point of ramps)
    expect(Math.abs(point.actual - point.expected)).toBeLessThan(0.05);
  for (const [frame, visible] of [
    [299, false],
    [300, true],
    [449, true],
    [450, false],
  ] as const) {
    const data = await run("ffmpeg", [
      "-v",
      "error",
      "-i",
      out.path,
      "-vf",
      `select=eq(n\\,${frame}),crop=iw:500:0:1300,signalstats,metadata=print:file=-`,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ]);
    const max = Number(data.stdout.match(/lavfi.signalstats.YMAX=(\S+)/)?.[1]);
    expect(max > 200).toBe(visible);
  }
  const crossfade = await rgb(out.path, 315);
  expect(crossfade[0]).toBeGreaterThan(5);
  expect(crossfade[1]).toBeGreaterThan(5);
  const evidence = {
    artifact: out,
    duckDb,
    before,
    during,
    after,
    crossfade,
    ramps,
  };
  await writeFile(
    path.join(dir, "rich-evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("B1 rich30 evidence", JSON.stringify(evidence));
}, 180000);

test("active cancellation and expired lease cannot register or replace completed artifacts; cancelled export can retry", async () => {
  const store = new Store(path.join(dir, "cancel-worker.sqlite")),
    q = new WorkQueue(store, { leaseMs: 60000 }),
    deps = { store, root: dir, enqueue: (input: any) => q.enqueue(input) };
  try {
    store.put("projects", doc.id, doc);
    store.put("project-history", `${doc.id}:1`, doc);
    store.put("assets", asset.id, asset);
    const job = await requestProjectRender(
        doc.id,
        1,
        { aspect: "project", fps: 30, codec: "h264-aac" },
        deps,
      ),
      lease = (await q.claim("cancel-worker"))!,
      ac = new AbortController();
    const stages = studioRenderStages(deps),
      render = stages[1]!.run;
    stages[1]!.run = async (ctx) => {
      const timer = setTimeout(() => {
        void q.cancel(job.id);
        ac.abort();
      }, 10);
      try {
        return await render(ctx);
      } finally {
        clearTimeout(timer);
      }
    };
    await runJob(lease, ac.signal, { queue: q, stages, artifactRoot: dir });
    expect(q.get(job.id)?.status).toBe("cancelled");
    expect(store.list("renders")).toHaveLength(0);
    const retry = await requestProjectRender(
      doc.id,
      1,
      { aspect: "project", fps: 30, codec: "h264-aac" },
      deps,
    );
    expect(retry.id).not.toBe(job.id);
    const newer = (await q.claim("retry-worker"))!;
    await runJob(newer, new AbortController().signal, {
      queue: q,
      stages: studioRenderStages(deps),
      artifactRoot: dir,
    });
    expect(q.get(retry.id)?.status).toBe("complete");
    const prior = store.list<any>("renders")[0]!.value;
    const registration = studioRenderStages(deps)[2]!;
    await expect(
      registration.run({
        data: { artifact: { ...prior, id: "expired" } },
        fenced: () => {
          throw Error("lease expired");
        },
      } as any),
    ).rejects.toThrow("lease expired");
    expect(store.list("renders")).toHaveLength(1);
    expect(await readFile(prior.path)).toBeTruthy();
  } finally {
    store.close();
  }
}, 30000);

test("50ms non-frame-aligned audio loops retain exact phase in rendered PCM", async () => {
  const file = path.join(dir, "loop.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.5*sin(2*PI*4000*t)*lt(t,0.01)':s=48000:d=0.05",
    "-c:a",
    "pcm_s16le",
    "-y",
    file,
  ]);
  const a: AssetRef = {
    id: "loop",
    kind: "audio",
    location: file,
    checksum: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
    status: "ready",
    durationUs: 50000,
  };
  const d: ProjectDocument = {
    ...doc,
    id: "loop",
    tracks: [{ id: "audio", kind: "audio" }],
    items: [
      {
        id: "loop",
        trackId: "audio",
        assetId: "loop",
        startFrame: 0,
        durationFrames: 30,
        sourceInUs: 0,
        sourceOutUs: 50000,
        sourcePhaseUs: { numerator: "1000", denominator: "3" },
        loop: true,
        speed: 1,
      },
    ],
    sourceMappings: [
      { itemId: "loop", assetId: "loop", sourceInUs: 0, sourceOutUs: 50000 },
    ],
    captionCues: [],
  };
  const plan = await compileNormalizedProject(d, [a]),
    out = await renderNormalizedProject(
      plan,
      new AbortController().signal,
      path.join(dir, "loop-output"),
    ),
    samples = await pcm(out.path, "loop");
  for (const n of [1, 2, 5, 10, 18]) {
    const expected = n * 0.05 - 1 / 3000;
    expect(
      toneAmplitude(samples, expected + 0.002, 0.005, 4000),
    ).toBeGreaterThan(0.3);
    expect(toneAmplitude(samples, expected + 0.025, 0.005, 4000)).toBeLessThan(
      0.03,
    );
  }
}, 30000);

test("HDR rejects clearly and VFR normalizes rather than accumulating timestamp drift", async () => {
  const file = path.join(dir, "vfr.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=160x90:r=30:d=2",
    "-vf",
    "settb=1/30000,setpts=PTS+if(eq(N\\,10)\\,150\\,0)",
    "-fps_mode",
    "passthrough",
    "-enc_time_base",
    "1/30000",
    "-c:v",
    "libx264",
    "-y",
    file,
  ]);
  const a = {
    ...asset,
    location: file,
    checksum: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  };
  const plan = await compileNormalizedProject({ ...doc, captionCues: [] }, [a]),
    out = await renderNormalizedProject(
      plan,
      new AbortController().signal,
      path.join(dir, "vfr-output"),
    );
  expect(out.probe.durationUs).toBe(2e6);
  const hdr = path.join(dir, "hdr.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
    "-c:v",
    "libx264",
    "-x264-params",
    "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
    "-y",
    hdr,
  ]);
  await expect(
    compileNormalizedProject(doc, [
      {
        ...a,
        location: hdr,
        checksum: createHash("sha256")
          .update(await readFile(hdr))
          .digest("hex"),
      },
    ]),
  ).rejects.toThrow("HDR");
}, 30000);

test("mixed-rate fractional trims preserve source clock instead of shifting to the next native frame", async () => {
  const file = path.join(dir, "fractional24.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=s=160x90:r=24:d=2,geq=lum='16+N*50':cb=128:cr=128",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.5*sin(2*PI*4000*t)*between(t,0.041666667,0.061666667)':s=44100:d=2",
    "-c:v",
    "libx264",
    "-crf",
    "0",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    file,
  ]);
  const a = {
      ...asset,
      location: file,
      checksum: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    },
    d = {
      ...doc,
      items: [
        {
          ...doc.items[0]!,
          durationFrames: 30,
          sourceInUs: 1000,
          sourceOutUs: 1001000,
        },
      ],
      sourceMappings: [
        { itemId: "v1", assetId: "a", sourceInUs: 1000, sourceOutUs: 1001000 },
      ],
      captionCues: [],
    };
  const out = await renderNormalizedProject(
    await compileNormalizedProject(d, [a]),
    new AbortController().signal,
    path.join(dir, "fractional-output"),
  );
  const first = await rgb(out.path, 0);
  expect(first[0]).toBeLessThan(5);
  expect((await rgb(out.path, 1))[0]).toBeGreaterThan(40);
  const audio = await pcm(out.path, "fractional");
  expect(toneAmplitude(audio, 0.02, 0.005, 4000)).toBeLessThan(0.02);
  expect(toneAmplitude(audio, 0.044, 0.008, 4000)).toBeGreaterThan(0.25);
  let onset = 0.03;
  while (onset < 0.065 && toneAmplitude(audio, onset, 0.002, 4000) < 0.15)
    onset += 0.001;
  expect(Math.abs(onset - (1 / 24 - 0.001))).toBeLessThan(0.005);
  expect(Math.abs(onset - 1 / 30)).toBeLessThan(1 / 30);
}, 30000);

test("anamorphic contain and cover preserve display aspect before fit, including 90 degree rotation", async () => {
  const source = path.join(dir, "anamorphic.mp4"),
    rotated = path.join(dir, "anamorphic-rotated.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=160x90:r=30:d=1,drawbox=x=0:y=0:w=20:h=ih:color=blue:t=fill,drawbox=x=140:y=0:w=20:h=ih:color=green:t=fill,setsar=2/1",
    "-c:v",
    "libx264",
    "-crf",
    "0",
    "-y",
    source,
  ]);
  await run("ffmpeg", [
    "-v",
    "error",
    "-display_rotation",
    "90",
    "-i",
    source,
    "-c",
    "copy",
    "-y",
    rotated,
  ]);
  for (const [file, rotation] of [
    [source, 0],
    [rotated, 90],
  ] as const) {
    const streams = JSON.parse(
      (
        await run("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-of",
          "json",
          file,
        ])
      ).stdout,
    ).streams;
    expect(streams[0]).toMatchObject({
      width: 160,
      height: 90,
      sample_aspect_ratio: "2:1",
      display_aspect_ratio: "32:9",
    });
    if (rotation)
      expect(
        streams[0].side_data_list.find((s: any) => s.rotation !== undefined)
          .rotation,
      ).toBe(rotation);
    for (const fit of ["contain", "cover"] as const) {
      const a = {
        ...asset,
        location: file,
        checksum: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
        durationUs: 1e6,
      };
      const d: ProjectDocument = {
        ...doc,
        captionCues: [],
        items: [
          { ...doc.items[0]!, durationFrames: 30, sourceOutUs: 1e6, fit },
        ],
        sourceMappings: [
          { itemId: "v1", assetId: "a", sourceInUs: 0, sourceOutUs: 1e6 },
        ],
      };
      const plan = await compileNormalizedProject(d, [a]);
      expect(plan.inputGeometry.a).toEqual({
        width: 160,
        height: 90,
        sampleAspectRatio: "2:1",
        rotation,
      });
      const out = await renderNormalizedProject(
        plan,
        new AbortController().signal,
        path.join(dir, `sar-${rotation}-${fit}`),
      );
      expect(out.normalizationPolicy).toContain(
        "display-aspect-preserving-square-pixel-resample-before-crop-fit",
      );
      const raw = path.join(dir, `sar-${rotation}-${fit}.rgb`);
      await run("ffmpeg", [
        "-v",
        "error",
        "-i",
        out.path,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-y",
        raw,
      ]);
      const bytes = await readFile(raw),
        pixel = (x: number, y: number) => [
          ...bytes.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3),
        ];
      const red = (x: number, y: number) => {
        const c = pixel(x, y);
        expect(c[0]).toBeGreaterThan(200);
        expect(c[1]).toBeLessThan(30);
        expect(c[2]).toBeLessThan(30);
      };
      const black = (x: number, y: number) =>
        expect(Math.max(...pixel(x, y))).toBeLessThan(10);
      red(80, 45);
      if (fit === "contain") {
        // DAR 32:9 fits as 160x45; after rotation DAR 9:32 fits as ~25x90.
        if (!rotation) {
          black(80, 10);
          black(80, 80);
          red(80, 30);
          red(80, 60);
        } else {
          black(60, 45);
          black(100, 45);
          red(74, 45);
          red(86, 45);
        }
      } else {
        // Fill crops the outer colored bands; all four edge midpoints remain red.
        red(4, 45);
        red(155, 45);
        red(80, 4);
        red(80, 85);
      }
      const outputStream = JSON.parse(
        (
          await run("ffprobe", [
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
            out.path,
          ])
        ).stdout,
      ).streams[0];
      expect(outputStream.sample_aspect_ratio).toBe("1:1");
    }
  }
}, 30000);
