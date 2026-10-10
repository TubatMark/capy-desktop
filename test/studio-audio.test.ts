import { expect, it } from "vitest";
import {
  applyEdit,
  mapSources,
  validateProject,
} from "../lib/studio/operations";
import {
  buildAudioPlan,
  audioGainAtFrame,
  audioSourceAtTime,
} from "../src/studio/audio-plan";
import type { AssetRef, ProjectDocument } from "../lib/studio/types";
const assets: AssetRef[] = [
  {
    id: "source",
    kind: "video",
    checksum: "s",
    location: "/s",
    durationUs: 10000000,
    status: "ready",
    streams: [{ kind: "audio", codec: "aac" }],
  },
  {
    id: "music",
    kind: "audio",
    checksum: "m",
    location: "/m",
    durationUs: 2000000,
    status: "ready",
  },
];
function fixture(): ProjectDocument {
  return mapSources({
    schemaVersion: 1,
    id: "p",
    revision: 1,
    canvas: { width: 1080, height: 1920 },
    fps: { numerator: 30, denominator: 1 },
    tracks: [
      { id: "video", kind: "video" },
      { id: "audio", kind: "audio", role: "music" },
    ],
    items: [
      {
        id: "v",
        trackId: "video",
        assetId: "source",
        startFrame: 30,
        durationFrames: 60,
        sourceInUs: 0,
        sourceOutUs: 2000000,
        speed: 1,
      },
      {
        id: "m",
        trackId: "audio",
        assetId: "music",
        startFrame: 0,
        durationFrames: 150,
        sourceInUs: 0,
        sourceOutUs: 2000000,
        speed: 1,
        audioRole: "music",
        loop: true,
        gain: 0.5,
        fadeInFrames: 6,
        fadeOutFrames: 9,
        ducking: {
          enabled: true,
          reductionDb: 12,
          attackMs: 100,
          releaseMs: 300,
        },
      },
    ],
    sourceMappings: [],
    captionCues: [],
    thumbnailIds: [],
  });
}
it("audio_controls_match_timeline", () => {
  const doc = fixture();
  const plan = buildAudioPlan(doc, assets);
  const music = plan.clips.find((c) => c.itemId === "m")!;
  expect(
    music.segments.map((s) => [
      s.startFrame,
      s.durationFrames,
      s.sourceInUs,
      s.sourceOutUs,
    ]),
  ).toEqual([
    [0, 60, 0, 2000000],
    [60, 60, 0, 2000000],
    [120, 30, 0, 1000000],
  ]);
  expect(audioGainAtFrame(plan, "m", 0)).toBe(0);
  const normal = audioGainAtFrame(plan, "m", 20);
  expect(audioGainAtFrame(plan, "m", 40) / normal).toBeCloseTo(
    10 ** (-12 / 20),
  );
  expect(audioGainAtFrame(plan, "m", 100)).toBeCloseTo(normal);
  expect(audioGainAtFrame(plan, "m", 149)).toBeLessThan(normal);
  for (let f = 0; f < 150; f++)
    expect(
      plan.clips.reduce(
        (sum, c) => sum + audioGainAtFrame(plan, c.itemId, f),
        0,
      ),
    ).toBeLessThanOrEqual(1.000001);
  const trimmed = applyEdit(doc, {
    type: "trim",
    itemId: "m",
    inFrame: 30,
    outFrame: 120,
  }).document;
  expect(
    buildAudioPlan(trimmed, assets)
      .clips.find((c) => c.itemId === "m")
      ?.segments.reduce((n, s) => n + s.durationFrames, 0),
  ).toBe(90);
  const detached = applyEdit(doc, {
    type: "detach-audio",
    itemId: "v",
    newId: "dialogue",
    trackId: "voice",
  });
  expect(
    buildAudioPlan(detached.document, assets).clips.filter(
      (c) => c.assetId === "source",
    ),
  ).toHaveLength(1);
  const moved = applyEdit(detached.document, {
    type: "move",
    itemId: "v",
    startFrame: 45,
  }).document;
  expect(moved.items.find((i) => i.id === "dialogue")?.startFrame).toBe(45);
  const relinked = applyEdit(moved, {
    type: "relink-audio",
    itemId: "v",
  }).document;
  expect(relinked.items.find((i) => i.id === "v")).toMatchObject({
    startFrame: 45,
    durationFrames: 60,
  });
  expect(relinked.items.find((i) => i.id === "dialogue")).toBeUndefined();
  expect(applyEdit(detached.document, detached.inverse).document).toEqual(doc);
});
it("solo, mute and gain edits are reversible and reject unsafe envelopes", () => {
  const doc = fixture();
  let edited = applyEdit(doc, {
    type: "audio",
    itemId: "m",
    changes: { solo: true, gain: 0.8 },
  });
  expect(
    buildAudioPlan(edited.document, assets).clips.find((c) => c.itemId === "v")
      ?.enabled,
  ).toBe(false);
  expect(applyEdit(edited.document, edited.inverse).document).toEqual(doc);
  edited = applyEdit(doc, {
    type: "audio",
    itemId: "m",
    changes: { muted: true },
  });
  expect(
    audioGainAtFrame(buildAudioPlan(edited.document, assets), "m", 20),
  ).toBe(0);
  expect(() =>
    applyEdit(doc, {
      type: "audio",
      itemId: "m",
      changes: { fadeOutFrames: 151 },
    }),
  ).toThrow();
  expect(() =>
    applyEdit(doc, {
      type: "audio",
      itemId: "m",
      changes: {
        ducking: {
          enabled: true,
          reductionDb: -1,
          attackMs: 100,
          releaseMs: 300,
        },
      },
    }),
  ).toThrow();
  expect(() =>
    validateProject({ ...doc, items: [{ ...doc.items[0]!, gain: NaN }] }),
  ).toThrow();
});
it("crossfade consumes the overlap duration and undo restores the cut", () => {
  const doc = fixture();
  doc.items = doc.items.filter((i) => i.id === "v");
  doc.items[0]!.startFrame = 0;
  doc.items.push({ ...doc.items[0]!, id: "second", startFrame: 60 });
  mapSources(doc);
  const changed = applyEdit(doc, {
    type: "transition",
    itemId: "v",
    kind: "crossfade",
    durationFrames: 12,
  });
  expect(
    changed.document.items.find((i) => i.id === "second")?.startFrame,
  ).toBe(48);
  expect(
    changed.document.items.find((i) => i.id === "v")?.transitionOut,
  ).toEqual({ kind: "crossfade", durationFrames: 12 });
  expect(applyEdit(changed.document, changed.inverse).document).toEqual(doc);
  expect(
    applyEdit(changed.document, {
      type: "transition",
      itemId: "v",
      kind: "cut",
      durationFrames: 0,
    }).document.items.find((i) => i.id === "second")?.startFrame,
  ).toBe(60);
});

it("decibel gain converts to the shared mix and mute stays silent", async () => {
  const { dbToGain, gainToDb } = await import("../lib/studio/audio");
  expect(gainToDb(dbToGain(-6))).toBeCloseTo(-6);
  const doc = fixture();
  const changed = applyEdit(doc, {
    type: "audio",
    itemId: "m",
    changes: { gain: dbToGain(-6) },
  });
  expect(
    buildAudioPlan(changed.document, assets).clips.find((c) => c.itemId === "m")
      ?.gain,
  ).toBeCloseTo(0.501187, 6);
  const muted = applyEdit(changed.document, {
    type: "audio",
    itemId: "m",
    changes: { muted: true },
  }).document;
  expect(audioGainAtFrame(buildAudioPlan(muted, assets), "m", 20)).toBe(0);
});
it("editable loop endpoints and trims preserve the correct source phase", () => {
  const doc = fixture();
  const changed = applyEdit(doc, {
    type: "audio-duration",
    itemId: "m",
    durationFrames: 210,
  });
  const trimmed = applyEdit(changed.document, {
    type: "trim",
    itemId: "m",
    inFrame: 30,
    outFrame: 180,
  }).document;
  expect(
    buildAudioPlan(trimmed, assets)
      .clips.find((c) => c.itemId === "m")
      ?.segments.map((s) => [
        s.startFrame,
        s.durationFrames,
        s.sourceInUs,
        s.sourceOutUs,
      ]),
  ).toEqual([
    [0, 30, 1000000, 2000000],
    [30, 60, 0, 2000000],
    [90, 60, 0, 2000000],
  ]);
  const split = applyEdit(trimmed, {
    type: "split",
    itemId: "m",
    frame: 45,
    newId: "loop-tail",
  }).document;
  expect(
    buildAudioPlan(split, assets).clips.find((c) => c.itemId === "loop-tail")
      ?.segments[0],
  ).toMatchObject({ startFrame: 45, sourceInUs: 500000, durationFrames: 45 });
  expect(applyEdit(changed.document, changed.inverse).document).toEqual(doc);
});

it("waveforms use actual decoded peak samples across channels", async () => {
  const { waveformPeaks } = await import("../lib/studio/audio");
  expect(
    waveformPeaks(
      [
        new Float32Array([0.1, -0.9, 0.2, -0.3]),
        new Float32Array([0.4, 0.5, -0.8, 0.6]),
      ],
      2,
    )[0],
  ).toBeCloseTo(0.9);
  expect(
    waveformPeaks(
      [
        new Float32Array([0.1, -0.9, 0.2, -0.3]),
        new Float32Array([0.4, 0.5, -0.8, 0.6]),
      ],
      2,
    )[1],
  ).toBeCloseTo(0.8);
});
it("detached source audio follows splits, trims, duplicates and ripple edits", () => {
  let doc = applyEdit(fixture(), {
    type: "detach-audio",
    itemId: "v",
    newId: "voice",
    trackId: "dialogue",
  }).document;
  doc = applyEdit(doc, {
    type: "split",
    itemId: "v",
    frame: 30,
    newId: "tail",
  }).document;
  expect(doc.items.find((i) => i.id === "tail:audio")).toMatchObject({
    startFrame: 60,
    durationFrames: 30,
    sourceInUs: 1000000,
    linkedVideoId: "tail",
  });
  doc = applyEdit(doc, {
    type: "trim",
    itemId: "tail",
    inFrame: 6,
    outFrame: 24,
  }).document;
  expect(doc.items.find((i) => i.id === "tail:audio")).toMatchObject({
    durationFrames: 18,
    sourceInUs: 1200000,
    sourceOutUs: 1800000,
  });
  doc = applyEdit(doc, {
    type: "duplicate",
    itemId: "tail",
    newId: "copy",
  }).document;
  expect(doc.items.find((i) => i.id === "copy:audio")).toMatchObject({
    startFrame: 78,
    durationFrames: 18,
    linkedVideoId: "copy",
  });
  doc = applyEdit(doc, { type: "ripple-delete", itemId: "v" }).document;
  expect(doc.items.find((i) => i.id === "tail:audio")?.startFrame).toBe(30);
  expect(doc.items.find((i) => i.id === "voice")).toBeUndefined();
  validateProject(doc);
});

it("source crossfade envelopes and later split/reorder preserve usable transition semantics", () => {
  const doc = fixture();
  doc.items = doc.items.filter((i) => i.id === "v");
  doc.items[0]!.startFrame = 0;
  doc.items.push({ ...doc.items[0]!, id: "next", startFrame: 60 });
  mapSources(doc);
  const changed = applyEdit(doc, {
    type: "transition",
    itemId: "v",
    kind: "crossfade",
    durationFrames: 12,
  }).document;
  const plan = buildAudioPlan(changed, assets);
  expect(audioGainAtFrame(plan, "v", 54)).toBeCloseTo(0.25);
  expect(audioGainAtFrame(plan, "next", 54)).toBeCloseTo(0.25);
  const split = applyEdit(changed, {
    type: "split",
    itemId: "v",
    frame: 30,
    newId: "tail",
  }).document;
  expect(split.items.find((i) => i.id === "v")?.transitionOut).toBeUndefined();
  expect(
    split.items.find((i) => i.id === "tail")?.transitionOut?.durationFrames,
  ).toBe(12);
  const reordered = applyEdit(changed, {
    type: "reorder",
    itemIds: ["next", "v"],
  }).document;
  expect(
    reordered.items.find((i) => i.id === "v")?.transitionOut,
  ).toBeUndefined();
});

it("shorten then split/trim uses one speed-1 source clock and restores exact inverses", async () => {
  const { sourceTimeUs } = await import("../lib/studio/audio");
  const base = fixture();
  const sound = base.items.find((i) => i.id === "m")!;
  sound.loop = false;
  sound.durationFrames = 60;
  delete sound.loopOffsetUs;
  mapSources(base);
  const shortened = applyEdit(base, {
    type: "audio-duration",
    itemId: "m",
    durationFrames: 30,
  });
  const before = sourceTimeUs(
    shortened.document.items.find((i) => i.id === "m")!,
    15,
    base,
  );
  expect(before).toBe(500000);
  const split = applyEdit(shortened.document, {
    type: "split",
    itemId: "m",
    frame: 15,
    newId: "short-tail",
  });
  expect(
    sourceTimeUs(
      split.document.items.find((i) => i.id === "short-tail")!,
      15,
      base,
    ),
  ).toBe(before);
  expect(
    split.document.items.find((i) => i.id === "short-tail")?.sourceInUs,
  ).toBe(500000);
  const trimmed = applyEdit(shortened.document, {
    type: "trim",
    itemId: "m",
    inFrame: 15,
    outFrame: 30,
  });
  expect(
    sourceTimeUs(
      trimmed.document.items.find((i) => i.id === "m")!,
      0,
      base,
    ),
  ).toBe(before);
  expect(applyEdit(split.document, split.inverse).document).toEqual(
    shortened.document,
  );
  expect(applyEdit(shortened.document, shortened.inverse).document).toEqual(
    base,
  );
  const extended = applyEdit(shortened.document, {
    type: "audio-duration",
    itemId: "m",
    durationFrames: 60,
  });
  expect(extended.document.items.find((i) => i.id === "m")?.sourceOutUs).toBe(
    2000000,
  );
});
it.each([
  { numerator: 30, denominator: 1 },
  { numerator: 30000, denominator: 1001 },
])(
  "sub-frame loop boundaries agree with audition through later iterations at $numerator/$denominator fps",
  async (fps) => {
    const { sourceTimeUs, sourceFrameTimeUs } =
      await import("../lib/studio/audio");
    const { frameTimeUs } = await import("../lib/studio/time");
    const doc = fixture();
    doc.fps = fps;
    doc.items = doc.items.filter((i) => i.id === "m");
    const item = doc.items[0]!;
    item.sourceOutUs = 50000;
    item.durationFrames = 300;
    item.fadeInFrames = 0;
    item.fadeOutFrames = 0;
    mapSources(doc);
    const smallAssets = [{ ...assets[1]!, durationUs: 50000 }];
    const assertClock = (edited: ProjectDocument, id: string) => {
      const sound = edited.items.find((i) => i.id === id)!;
      const plan = buildAudioPlan(edited, smallAssets);
      const clip = plan.clips.find((c) => c.itemId === id)!;
      for (const offset of [0, 1, 2, 5, 37, 100, 200].filter(
        (f) => f < sound.durationFrames,
      )) {
        const frame = sound.startFrame + offset;
        const segment = clip.segments.find(
          (s) =>
            frame >= s.startFrame - 1e-9 &&
            frame < s.startFrame + s.durationFrames - 1e-9,
        )!;
        const mapped =
          segment.sourceInUs +
          ((frame - segment.startFrame) * 1000000 * fps.denominator) /
            fps.numerator;
        expect(mapped).toBeCloseTo(sourceTimeUs(sound, frame, edited), 6);
        expect(audioSourceAtTime(clip, frameTimeUs(frame, edited))).toEqual(
          sourceFrameTimeUs(sound, frame, edited),
        );
      }
    };
    assertClock(doc, "m");
    expect(
      buildAudioPlan(doc, smallAssets).clips[0]?.segments[0]?.durationUs,
    ).toEqual({ numerator: "50000", denominator: "1" });
    expect(
      buildAudioPlan(doc, smallAssets).clips[0]?.segments[0]?.durationFrames,
    ).toBeCloseTo((50000 * fps.numerator) / (1000000 * fps.denominator), 12);
    const trim = applyEdit(doc, {
      type: "trim",
      itemId: "m",
      inFrame: 2,
      outFrame: 280,
    }).document;
    assertClock(trim, "m");
    expect(sourceTimeUs(trim.items[0]!, 0, trim)).toBeCloseTo(
      ((2 * 1000000 * fps.denominator) / fps.numerator) % 50000,
      9,
    );
    const split = applyEdit(trim, {
      type: "split",
      itemId: "m",
      frame: 3,
      newId: "fraction-tail",
    }).document;
    assertClock(split, "fraction-tail");
    expect(
      sourceTimeUs(
        split.items.find((i) => i.id === "fraction-tail")!,
        3,
        split,
      ),
    ).toBeCloseTo(((5 * 1000000 * fps.denominator) / fps.numerator) % 50000, 9);
  },
);
