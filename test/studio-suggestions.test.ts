import { applyEdit } from "../lib/studio/operations";
import { expect, it } from "vitest";
import {
  suggestEdits,
  applySuggestions,
} from "../server/studio/edit-suggestions";
import { project } from "./fixtures/studio-advanced";
it("ai_edits_are_reversible_and_bounded", async () => {
  const doc = project();
  const proposal = await suggestEdits({
    document: doc,
    selectedItemIds: ["a"],
    kind: "reframe",
    fit: "contain",
  });
  expect(proposal).toHaveLength(1);
  const result = applySuggestions(doc, proposal, ["a"]);
  expect(result.document.items[0]!.fit).toBe("contain");
  expect(() =>
    applySuggestions({ ...doc, revision: 5 }, proposal, ["a"]),
  ).toThrow(/revision/i);
  expect(() => applySuggestions(doc, proposal, [])).toThrow(/selection/i);
  expect(doc.items[0]!.fit).toBeUndefined();
});
it("speaker framing requires exact confirmed checksum and coverage, with a safe fallback", async () => {
  const doc = project(),
    assets = [
      {
        id: "asset",
        kind: "video" as const,
        status: "ready" as const,
        location: "/safe/source",
        checksum: "abc",
      },
    ],
    region = {
      sourceChecksum: "abc",
      confirmedByUser: true as const,
      startUs: 0,
      endUs: 4000000,
      crop: { x: 0.2, y: 0, width: 0.5, height: 1 },
    };
  const input = {
    document: doc,
    selectedItemIds: ["a"],
    kind: "reframe" as const,
    assets,
    speakerRegions: { a: region },
  };
  const proposal = await suggestEdits(input);
  expect(
    applySuggestions(doc, proposal, ["a"]).document.items[0]!.crop,
  ).toEqual(region.crop);
  await expect(
    suggestEdits({
      ...input,
      speakerRegions: { a: { ...region, sourceChecksum: "stale" } },
    }),
  ).rejects.toThrow(/Speaker region/);
  await expect(
    suggestEdits({
      ...input,
      speakerRegions: { a: { ...region, endUs: 1000000 } },
    }),
  ).rejects.toThrow(/Speaker region/);
  await expect(
    suggestEdits({
      ...input,
      speakerRegions: { a: { ...region, confirmedByUser: false as never } },
    }),
  ).rejects.toThrow(/Speaker region/);
  const changed = structuredClone(doc);
  changed.items[0]!.gain = 0.5;
  expect(() => applySuggestions(changed, proposal, ["a"])).toThrow(/revision/);
});
it("silence proposals trim measured edges only and preserve unselected items and undo", async () => {
  const doc = project();
  doc.items.push({ ...doc.items[0]!, id: "other", startFrame: 120 });
  doc.sourceMappings.push({ ...doc.sourceMappings[0]!, itemId: "other" });
  const proposal = await suggestEdits({
    document: doc,
    selectedItemIds: ["a"],
    kind: "silence",
    silence: {
      a: [
        { startUs: 0, endUs: 500000 },
        { startUs: 3500000, endUs: 4000000 },
      ],
    },
  });
  const result = applySuggestions(doc, proposal, ["a"]);
  expect(result.document.items[0]).toMatchObject({
    startFrame: 0,
    durationFrames: 90,
    sourceInUs: 500000,
    sourceOutUs: 3500000,
  });
  expect(result.document.items[1]).toEqual(doc.items[1]);
  expect(applyEdit(result.document, result.inverse).document).toEqual(doc);
  const malicious = structuredClone(proposal);
  if (malicious[0]?.type === "suggested")
    malicious[0].operations = [{ type: "remove", itemId: "other" }];
  expect(() => applySuggestions(doc, malicious, ["a"])).toThrow(/selected/);
});
