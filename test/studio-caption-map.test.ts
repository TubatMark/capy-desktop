import { expect, it } from "vitest";
import { applyEdit, mapSources } from "../lib/studio/operations";
import { mapCaptionCues } from "../lib/studio/caption-map";
import type { ProjectDocument, SourceWords } from "../lib/studio/types";
const words: SourceWords[] = [
  {
    assetId: "source",
    words: [
      { id: "first", startUs: 0, endUs: 1000000, text: "first" },
      { id: "middle", startUs: 4000000, endUs: 5000000, text: "removed" },
      { id: "last", startUs: 8000000, endUs: 9000000, text: "last" },
    ],
  },
];
function fixture(): ProjectDocument {
  return mapSources({
    schemaVersion: 1,
    id: "p",
    revision: 1,
    canvas: { width: 1080, height: 1920 },
    fps: { numerator: 30, denominator: 1 },
    tracks: [{ id: "video", kind: "video" }],
    items: [
      {
        id: "a",
        trackId: "video",
        assetId: "source",
        startFrame: 0,
        durationFrames: 300,
        sourceInUs: 0,
        sourceOutUs: 10000000,
        speed: 1,
      },
    ],
    sourceMappings: [],
    captionCues: [],
    sourceWords: words,
    thumbnailIds: [],
  });
}
it("captions_follow_ripple_and_reorder", () => {
  const before = fixture();
  let doc = applyEdit(before, {
    type: "split",
    itemId: "a",
    frame: 120,
    newId: "middle",
  }).document;
  doc = applyEdit(doc, {
    type: "split",
    itemId: "middle",
    frame: 60,
    newId: "tail",
  }).document;
  doc = applyEdit(doc, { type: "ripple-delete", itemId: "middle" }).document;
  const cues = mapCaptionCues(doc, words);
  expect(cues.map((c) => [c.text, c.startFrame])).toEqual([
    ["first", 0],
    ["last", 180],
  ]);
  expect(before.items[0]?.durationFrames).toBe(300);
  doc = applyEdit(doc, {
    type: "duplicate",
    itemId: "a",
    newId: "repeat",
  }).document;
  doc = applyEdit(doc, {
    type: "reorder",
    itemIds: ["repeat", "tail", "a"],
  }).document;
  const repeat = mapCaptionCues(doc, words).filter((c) => c.text === "first");
  expect(repeat.map((c) => c.startFrame)).toEqual([0, 240]);
  expect(new Set(repeat.map((c) => c.id)).size).toBe(2);
});
it("manual caption text, timing and style survive remapping and splits", () => {
  let doc = fixture();
  const id = doc.captionCues.find((c) => c.text === "last")!.id;
  doc = applyEdit(doc, {
    type: "caption",
    cueId: id,
    changes: {
      text: "Edited",
      startFrame: 245,
      durationFrames: 20,
      x: 0.3,
      y: 0.7,
      fontSize: 60,
      color: "#ffffff",
    },
  }).document;
  doc = applyEdit(doc, {
    type: "split",
    itemId: "a",
    frame: 120,
    newId: "b",
  }).document;
  doc = applyEdit(doc, { type: "ripple-delete", itemId: "a" }).document;
  expect(doc.captionCues.find((c) => c.text === "Edited")).toMatchObject({
    startFrame: 125,
    durationFrames: 20,
    x: 0.3,
    y: 0.7,
    fontSize: 60,
  });
});
it("rational fps rounds source boundaries once and ignores overlay dialogue", () => {
  const doc = fixture();
  doc.fps = { numerator: 30000, denominator: 1001 };
  doc.tracks.push({ id: "overlay", kind: "video", role: "overlay" });
  doc.items.push({ ...doc.items[0]!, id: "overlay", trackId: "overlay" });
  expect(mapCaptionCues(doc, words).map((c) => c.startFrame)).toEqual([
    0, 120, 240,
  ]);
});
