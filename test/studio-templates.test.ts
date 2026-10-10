import { expect, it } from "vitest";
import { applyTemplate, motionAtFrame } from "../lib/studio/templates";
import { applyEdit, validateProject } from "../lib/studio/operations";
import { project } from "./fixtures/studio-advanced";
it("motion_seeks_repeatably", () => {
  const d = project();
  const result = applyTemplate(d, {
    id: "local-title",
    version: 1,
    instanceId: "intro",
    parameters: {
      text: "My intro",
      placement: "intro",
      durationFrames: 30,
      color: "#ffffff",
    },
  });
  const title = result.document.items.find((i) => i.id === "intro")!;
  const direct = motionAtFrame(title, 15);
  expect([29, 0, 15].map((f) => motionAtFrame(title, f))[2]).toEqual(direct);
  expect(direct.x).not.toEqual(motionAtFrame(title, 0).x);
  expect(applyEdit(result.document, result.inverse).document).toEqual(d);
  expect(() =>
    applyTemplate(d, {
      id: "local-title",
      version: 2,
      instanceId: "x",
      parameters: {},
    } as never),
  ).toThrow();
});
it("rejects unsupported motion properties at save boundary", () => {
  const d = project();
  Object.assign(d.items[0]!, {
    keyframes: [{ frame: 0, x: 0, y: 0, scale: 1, rotation: 0, script: "bad" }],
  });
  expect(() => validateProject(d)).toThrow();
});
it("duplicates a local template with a fresh instance identity and preserved version", () => {
  const original = applyTemplate(project(), {
    id: "local-title",
    version: 1,
    instanceId: "title",
    parameters: {
      text: "Reusable",
      placement: "intro",
      durationFrames: 30,
      color: "#ffffff",
    },
  }).document;
  const copy = applyEdit(original, {
    type: "duplicate",
    itemId: "title",
    newId: "title-copy",
  });
  expect(
    copy.document.items.find((i) => i.id === "title-copy")?.template,
  ).toEqual({
    id: "local-title",
    version: 1,
    instanceId: "title-copy",
    font: "Arial",
  });
  expect(applyEdit(copy.document, copy.inverse).document).toEqual(original);
});
