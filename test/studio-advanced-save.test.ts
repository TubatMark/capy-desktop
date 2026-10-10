import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/db";
import { importAsset } from "../server/studio/assets";
import {
  createProject,
  saveProject,
  getProject,
  projectHistory,
} from "../server/studio/projects";
import { retimeItem, freezeItem } from "../lib/studio/retiming";
import { applyTemplate } from "../lib/studio/templates";
it("public save rejects unsupported advanced fields without changing project or history and reopens supported edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capy-b7-save-")),
    store = new Store(path.join(root, "db.sqlite"));
  try {
    const deps = { root, store, enqueue: async () => ({ id: "job" }) },
      file = path.join(root, "original.mp4");
    await writeFile(file, "immutable original");
    const a = await importAsset({ path: file, kind: "video" }, deps);
    store.put("assets", a.id, { ...a, status: "ready", durationUs: 4000000 });
    const doc = await createProject({ sources: [{ assetId: a.id }] }, deps),
      history = projectHistory(doc.id, deps);
    for (const bad of [
      { speed: 3 },
      { freeze: { sourceUs: 0, audioPolicy: "repeat" } },
      { freeze: { sourceUs: 4000000, audioPolicy: "silence" } },
      {
        keyframes: [
          { frame: 0, x: 0, y: 0, scale: 1, rotation: 0, script: "evil" },
        ],
      },
      { keyframes: [{ frame: 120, x: 0, y: 0, scale: 1, rotation: 0 }] },
      {
        template: {
          id: "local-title",
          version: 99,
          instanceId: doc.items[0]!.id,
          font: "Arial",
        },
      },
    ]) {
      const invalid = structuredClone(doc);
      Object.assign(invalid.items[0]!, bad);
      await expect(saveProject(invalid, doc.revision, deps)).rejects.toThrow();
      expect(getProject(doc.id, deps)).toEqual(doc);
      expect(projectHistory(doc.id, deps)).toEqual(history);
    }
    let edited = retimeItem(doc, doc.items[0]!.id, 0.5).document;
    edited = applyTemplate(edited, {
      id: "local-title",
      version: 1,
      instanceId: "title",
      parameters: {
        text: "Local",
        placement: "outro",
        color: "#ffffff",
        durationFrames: 30,
      },
    }).document;
    const saved = await saveProject(edited, doc.revision, deps);
    expect(getProject(doc.id, deps)).toEqual(saved);
    expect(saved.items[0]!.speed).toBe(0.5);
    const frozen = freezeItem(
      saved,
      saved.items[0]!.id,
      30,
      60,
      "silence",
    ).document;
    const next = await saveProject(frozen, saved.revision, deps);
    expect(getProject(doc.id, deps)).toEqual(next);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
