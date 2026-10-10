import { describe, expect, it } from "vitest";
import { applyEdit, validateProject } from "../lib/studio/operations";
import type { ProjectDocument } from "../lib/studio/types";
export const fixture = (): ProjectDocument => ({
  schemaVersion: 1,
  id: "p",
  revision: 1,
  canvas: { width: 1080, height: 1920 },
  fps: { numerator: 30, denominator: 1 },
  tracks: [{ id: "v", kind: "video" }],
  items: [
    {
      id: "a",
      trackId: "v",
      assetId: "source",
      startFrame: 0,
      durationFrames: 300,
      sourceInUs: 1000000,
      sourceOutUs: 11000000,
      speed: 1,
    },
  ],
  sourceMappings: [
    {
      itemId: "a",
      assetId: "source",
      sourceInUs: 1000000,
      sourceOutUs: 11000000,
    },
  ],
  captionCues: [],
  thumbnailIds: [],
});
describe("nondestructive edits", () => {
  it("split_trim_reorder_preserves_sources", () => {
    const doc = fixture();
    const split = applyEdit(doc, {
      type: "split",
      itemId: "a",
      frame: 90,
      newId: "b",
    });
    expect(split.document.items.map((i) => i.durationFrames)).toEqual([
      90, 210,
    ]);
    expect(split.document.items[1]?.sourceInUs).toBe(4000000);
    expect(applyEdit(split.document, split.inverse).document).toEqual(doc);
    expect(doc.items[0]?.durationFrames).toBe(300);
    const trim = applyEdit(doc, {
      type: "trim",
      itemId: "a",
      inFrame: 30,
      outFrame: 120,
    });
    expect(trim.document.items[0]).toMatchObject({
      durationFrames: 90,
      sourceInUs: 2000000,
      sourceOutUs: 5000000,
    });
    expect(
      applyEdit(split.document, {
        type: "reorder",
        itemIds: ["b", "a"],
      }).document.items.find((i) => i.id === "b")?.startFrame,
    ).toBe(0);
    expect(
      applyEdit(split.document, { type: "ripple-delete", itemId: "a" }).document
        .items[0]?.startFrame,
    ).toBe(0);
  });
  it("rejects zero negative out of range and malformed documents", () => {
    for (const frame of [0, -1, 300, 301, NaN])
      expect(() =>
        applyEdit(fixture(), { type: "split", itemId: "a", frame, newId: "b" }),
      ).toThrow();
    expect(() =>
      applyEdit(fixture(), {
        type: "trim",
        itemId: "a",
        inFrame: 20,
        outFrame: 20,
      }),
    ).toThrow();
    expect(() =>
      applyEdit(fixture(), { type: "move", itemId: "a", startFrame: -1 }),
    ).toThrow();
    expect(() =>
      validateProject({
        ...fixture(),
        items: [{ ...fixture().items[0]!, durationFrames: 0 }],
      }),
    ).toThrow();
  });
  it("duplicates and transforms with exact inverse and revision preservation", () => {
    const doc = fixture();
    const result = applyEdit(doc, {
      type: "duplicate",
      itemId: "a",
      newId: "b",
    });
    expect(result.document.items).toHaveLength(2);
    const changed = { ...result.document, revision: 5 };
    expect(applyEdit(changed, result.inverse).document.revision).toBe(5);
    expect(
      applyEdit(doc, {
        type: "transform",
        itemId: "a",
        transform: { x: 10, y: 20, scale: 2, rotation: 0 },
      }).document.items[0]?.transform?.scale,
    ).toBe(2);
  });
});

describe("exact source metadata validation", () => {
  it.each([
    null,
    [],
    "0",
    {},
    { numerator: "0", denominator: "0" },
    { numerator: "0", denominator: "-1" },
    { numerator: "-1", denominator: "3" },
    { numerator: "0.5", denominator: "3" },
    { numerator: 0, denominator: "3" },
    { numerator: "1".repeat(41), denominator: "3" },
    { numerator: "1", denominator: "1".repeat(41) },
    { numerator: "1", denominator: "3", extra: true },
    { numerator: "1", denominator: "1" },
  ].map((phase) => [phase]))(
    "rejects malformed or noncanonical non-loop phase %j",
    (phase) => {
      const doc = fixture();
      Object.assign(doc.items[0]!, { sourcePhaseUs: phase });
      expect(() => validateProject(doc)).toThrow("Invalid source phase");
    },
  );
  it.each([NaN, Infinity, -1, 1000000.5, Number.MAX_SAFE_INTEGER + 1, 10999999])(
    "rejects invalid retained extent %j",
    (extent) => {
      const doc = fixture();
      doc.items[0]!.sourceAvailableOutUs = extent;
      expect(() => validateProject(doc)).toThrow("Invalid retained source extent");
    },
  );
  it("rejects source metadata without an asset range", () => {
    for (const metadata of [
      { sourcePhaseUs: { numerator: "1", denominator: "3" } },
      { sourceAvailableOutUs: 1000000 },
    ]) {
      const doc = fixture();
      const item = doc.items[0]!;
      delete item.assetId;
      item.text = { value: "Title", fontSize: 40, color: "#ffffff" };
      Object.assign(item, metadata);
      expect(() => validateProject(doc)).toThrow();
    }
  });
  it("bounds combined loop phase and validates linked source metadata", () => {
    const doc = fixture();
    doc.items[0]!.loop = true;
    doc.items[0]!.sourcePhaseUs = { numerator: "9999999", denominator: "1" };
    doc.items[0]!.loopOffsetUs = 1;
    expect(() => validateProject(doc)).toThrow("Invalid source phase");
    delete doc.items[0]!.loopOffsetUs;
    validateProject(doc);
    const detached = applyEdit(doc, {
      type: "detach-audio",
      itemId: "a",
      newId: "sound",
      trackId: "sound-track",
    }).document;
    const sound = detached.items.find((i) => i.id === "sound")!;
    sound.sourcePhaseUs = { numerator: "0", denominator: "1" };
    expect(() => validateProject(detached)).toThrow("Invalid detached audio link");
    sound.sourcePhaseUs = { numerator: "19999998", denominator: "2" };
    validateProject(detached);
    sound.sourceAvailableOutUs = 12000000;
    expect(() => validateProject(detached)).toThrow("Invalid detached audio link");
  });
});
