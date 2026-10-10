import { expect, it } from "vitest";
import { retimeItem, freezeItem } from "../lib/studio/retiming";
import {
  applyEdit,
  mapSources,
  validateProject,
} from "../lib/studio/operations";
import { sourceTimeUs } from "../lib/studio/audio";
import { buildAudioPlan } from "../src/studio/audio-plan";
import type { ProjectDocument } from "../lib/studio/types";
import { project } from "./fixtures/studio-advanced";
it("speed_and_freeze_remap_audio_captions", () => {
  const doc = project();
  for (const speed of [0.5, 2]) {
    const result = retimeItem(doc, "a", speed);
    expect(result.document.items[0]!.durationFrames).toBe(120 / speed);
    expect(result.document.captionCues[0]).toMatchObject({
      startFrame: 30 / speed,
      durationFrames: 30 / speed,
    });
    expect(sourceTimeUs(result.document.items[0]!, 30, result.document)).toBe(
      1000000 * speed,
    );
    expect(applyEdit(result.document, result.inverse).document).toEqual(doc);
  }
  const frozen = freezeItem(doc, "a", 45, 90, "silence");
  expect(frozen.document.items[0]!.durationFrames).toBe(90);
  expect(sourceTimeUs(frozen.document.items[0]!, 80, doc)).toBe(1500000);
  expect(frozen.document.captionCues[0]).toMatchObject({
    startFrame: 0,
    durationFrames: 90,
  });
  expect(
    buildAudioPlan(frozen.document, [
      {
        id: "asset",
        kind: "video",
        checksum: "x",
        location: "/fixture",
        status: "ready",
        streams: [{ kind: "audio", codec: "aac" }],
      },
    ]).clips[0]!.enabled,
  ).toBe(false);
  expect(applyEdit(frozen.document, frozen.inverse).document).toEqual(doc);
});
it("rejects unsafe retiming and unsupported saved fields", () => {
  expect(() => retimeItem(project(), "a", 3)).toThrow();
  const d = project();
  Object.assign(d.items[0]!, {
    freeze: { sourceUs: 1, audioPolicy: "surprise" },
  });
  expect(() => validateProject(d)).toThrow();
});
