import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/db";
import {
  createProject,
  saveProject,
  projectHistory,
} from "../server/studio/projects";
import { importAsset, relinkAsset } from "../server/studio/assets";
let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "capy-b2-"));
  store = new Store(path.join(dir, "db.sqlite"));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});
it("merge_creates_new_project and preserves originals", async () => {
  const file = path.join(dir, "original.mp4");
  await writeFile(file, "fixture bytes");
  const queue: any[] = [];
  const deps = {
    store,
    root: dir,
    enqueue: async (input: any) => {
      queue.push(input);
      return { id: "work" };
    },
  };
  const asset = await importAsset({ path: file, kind: "video" }, deps);
  expect(asset.status).toBe("probing");
  expect(queue[0].kind).toBe("asset-probe");
  store.put("assets", asset.id, {
    ...asset,
    status: "ready",
    durationUs: 10000000,
  });
  const jobs = [1, 2].map((n) => ({
    id: `job${n}`,
    title: `Source ${n}`,
    videoId: n === 1 ? "ABCDEFGHIJK" : "LMNOPQRSTUV",
    duration: 20,
    clips: [
      {
        n: 1,
        title: `Clip ${n}`,
        start: 2,
        end: 7,
        segment: {
          start: 0,
          end: 10,
          url: "/api/media/original.mp4",
          status: "done",
        },
      },
    ],
  }));
  for (const job of jobs) store.put("legacy-jobs", job.id, job);
  const doc = await createProject(
    {
      name: "Merged",
      sources: [
        { jobId: "job1", clipN: 1 },
        { jobId: "job2", clipN: 1 },
        { assetId: asset.id, startUs: 0, endUs: 5000000 },
      ],
    },
    deps,
  );
  expect(doc.items).toHaveLength(3);
  expect(doc.items[1]?.startFrame).toBe(150);
  expect(doc.items[2]?.startFrame).toBe(300);
  expect(
    doc.sourceMappings.map(
      (m) => store.get<any>("assets", m.assetId)?.value.original?.jobId,
    ),
  ).toEqual(["job1", "job2", undefined]);
  for (const job of jobs)
    expect(store.get("legacy-jobs", job.id)).toEqual({
      id: job.id,
      revision: 0,
      value: job,
    });
  expect(await readFile(file, "utf8")).toBe("fixture bytes");
  const saved = await saveProject(
    { ...doc, name: "Changed" },
    doc.revision,
    deps,
  );
  expect(saved.revision).toBe(2);
  await expect(saveProject(doc, doc.revision, deps)).rejects.toMatchObject({
    status: 409,
  });
  expect(projectHistory(doc.id, deps)).toHaveLength(2);
});
it("full source requests exact footage beyond cache and waits durably", async () => {
  const queue: any[] = [];
  store.put("legacy-jobs", "j", {
    id: "j",
    videoId: "ABCDEFGHIJK",
    duration: 100,
    clips: [
      {
        n: 1,
        start: 10,
        end: 20,
        segment: {
          start: 0,
          end: 35,
          url: "/api/media/cache.mp4",
          status: "done",
        },
      },
    ],
  });
  const doc = await createProject(
    { sources: [{ jobId: "j", clipN: 1, startUs: 60000000, endUs: 70000000 }] },
    {
      store,
      root: dir,
      enqueue: async (input: any) => {
        queue.push(input);
        return { id: "request" };
      },
    },
  );
  const asset = store.get<any>("assets", doc.items[0]!.assetId!)!.value;
  expect(asset.status).toBe("waiting");
  expect(queue[0]).toMatchObject({
    kind: "source-range",
    payload: { startUs: 60000000, endUs: 70000000, videoId: "ABCDEFGHIJK" },
  });
  expect(doc.items[0]).toMatchObject({ sourceInUs: 0, sourceOutUs: 10000000 });
});
it("relink checks matching content and rejects traversal and invalid seeds", async () => {
  const file = path.join(dir, "x.mp4");
  await writeFile(file, "same");
  const deps = { store, root: dir, enqueue: async () => ({ id: "w" }) };
  const asset = await importAsset({ path: file, kind: "video" }, deps);
  const replacement = path.join(dir, "new.mp4");
  await writeFile(replacement, "different");
  await expect(relinkAsset(asset.id, replacement, deps)).rejects.toThrow(
    "checksum",
  );
  await writeFile(replacement, "same");
  expect((await relinkAsset(asset.id, replacement, deps)).id).toBe(asset.id);
  await expect(
    importAsset({ path: "../../etc/passwd", kind: "video" }, deps),
  ).rejects.toThrow();
  await expect(
    createProject(
      { sources: [{ assetId: asset.id, startUs: -1, endUs: 100 }] },
      deps,
    ),
  ).rejects.toThrow();
});

it("queue admission failures remain visible and retryable without losing imported bytes", async () => {
  const file = path.join(dir, "capacity.mp4");
  await writeFile(file, "preserved bytes");
  await expect(
    importAsset(
      { path: file, kind: "video" },
      {
        store,
        root: dir,
        enqueue: async () => {
          throw Error("Worker queue capacity reached");
        },
      },
    ),
  ).rejects.toThrow("capacity");
  const row = store.list<any>("assets")[0]!;
  expect(row.value.status).toBe("failed");
  expect(await readFile(row.value.location, "utf8")).toBe("preserved bytes");
  const { retryAsset } = await import("../server/studio/assets");
  expect(
    (
      await retryAsset(row.id, {
        store,
        root: dir,
        enqueue: async () => ({ id: "recovered" }),
      })
    ).workId,
  ).toBe("recovered");
});

it("a missing cached segment requests recoverable source footage", async () => {
  const job = {
    id: "missing-cache",
    videoId: "ABCDEFGHIJK",
    duration: 100,
    clips: [
      {
        n: 1,
        start: 10,
        end: 20,
        segment: {
          start: 0,
          end: 35,
          url: "/api/media/gone.mp4",
          status: "done",
        },
      },
    ],
  };
  store.put("legacy-jobs", job.id, job);
  const queued: any[] = [];
  const document = await createProject(
    { sources: [{ jobId: job.id, clipN: 1 }] },
    {
      store,
      root: dir,
      enqueue: async (input) => {
        queued.push(input);
        return { id: "missing-range" };
      },
    },
  );
  expect(queued[0]).toMatchObject({
    kind: "source-range",
    payload: { startUs: 10000000, endUs: 20000000 },
  });
  expect(
    store.get<any>("assets", document.items[0]!.assetId!)!.value.status,
  ).toBe("waiting");
  expect(store.get("legacy-jobs", job.id)?.value).toEqual(job);
});

it("seeds existing local transcript words in asset microseconds without changing the legacy job", async () => {
  const file = path.join(dir, "captioned.mp4");
  await writeFile(file, "original bytes");
  await writeFile(
    path.join(dir, "words.json"),
    JSON.stringify([
      { text: "before", start: 1, end: 2 },
      { text: "mapped", start: 6, end: 7 },
      { text: "after", start: 12, end: 13 },
    ]),
  );
  const job = {
    id: "captioned",
    dir: ".",
    videoId: "ABCDEFGHIJK",
    duration: 30,
    clips: [
      {
        n: 1,
        start: 5,
        end: 10,
        segment: {
          start: 4,
          end: 14,
          url: "/api/media/captioned.mp4",
          status: "done",
        },
      },
    ],
  };
  store.put("legacy-jobs", job.id, job);
  const doc = await createProject(
    { sources: [{ jobId: job.id, clipN: 1 }] },
    { root: dir, store, enqueue: async () => ({ id: "w" }) },
  );
  expect(doc.captionCues.map((c) => [c.text, c.startFrame])).toEqual([
    ["mapped", 30],
  ]);
  expect(
    doc.sourceWords?.[0]?.words.find((w) => w.text === "mapped"),
  ).toMatchObject({ startUs: 2000000, endUs: 3000000 });
  expect(store.get("legacy-jobs", job.id)?.value).toEqual(job);
});
