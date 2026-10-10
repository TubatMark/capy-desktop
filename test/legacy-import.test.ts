import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "../server/db";
import { importLegacy } from "../server/db/import-legacy";
function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "capy-import-"));
  const outputRoot = path.join(dataDir, "output");
  mkdirSync(path.join(outputRoot, "moved"), { recursive: true });
  writeFileSync(
    path.join(dataDir, "watch.json"),
    JSON.stringify({ channels: [], maxPerDay: 6, intervalMin: 60 }),
  );
  writeFileSync(path.join(dataDir, "queue.json"), "[]");
  writeFileSync(path.join(outputRoot, "moved", "clip.mp4"), "unchanged");
  const job = {
    id: "j",
    videoId: "j",
    url: "u",
    dir: "moved",
    status: "ready",
    stage: "done",
    stageStartedAt: 0,
    createdAt: 0,
    settings: {
      count: 3,
      minSec: 20,
      maxSec: 60,
      layout: "center",
      style: "bold",
      captions: true,
      hook: true,
      maxRes: 1080,
    },
    estimate: { stageRemaining: 0, totalRemaining: 0, progress: 1 },
    log: [],
    clips: [
      {
        n: 1,
        start: 0,
        end: 2,
        title: "t",
        hook: "h",
        reason: "r",
        score: 1,
        selected: true,
        render: { status: "done", file: "/old/clip.mp4" },
      },
      {
        n: 2,
        start: 2,
        end: 4,
        title: "t",
        hook: "h",
        reason: "r",
        score: 1,
        selected: true,
        render: { status: "done", file: "/old/missing.mp4" },
      },
    ],
  };
  writeFileSync(
    path.join(outputRoot, "moved", "job.json"),
    JSON.stringify(job),
  );
  return { dataDir, outputRoot, store: openStore(dataDir) };
}
describe("legacy import", () => {
  it("migration_is_repeatable_and_reversible", async () => {
    const f = fixture();
    await expect(
      importLegacy({
        ...f,
        beforeCommit: () => {
          throw Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");
    expect(f.store.list("legacy-jobs")).toHaveLength(0);
    const first = await importLegacy(f);
    const second = await importLegacy(f);
    expect(first.imported).toHaveLength(3);
    expect(second.imported).toHaveLength(0);
    expect(first.unresolved).toHaveLength(1);
    expect(existsSync(path.join(first.backupLocation!, "before.sqlite"))).toBe(
      true,
    );
    expect(f.store.get<any>("assets", "j:clip:1")?.value.status).toBe("ready");
    expect(
      readFileSync(path.join(f.outputRoot, "moved", "clip.mp4"), "utf8"),
    ).toBe("unchanged");
    f.store.close();
  });
  it("malformed legacy never silently becomes empty", async () => {
    const f = fixture();
    writeFileSync(path.join(f.dataDir, "watch.json"), "{broken");
    await expect(importLegacy(f)).rejects.toThrow("corrupt");
    expect(f.store.list("legacy-jobs")).toHaveLength(0);
    expect(readFileSync(path.join(f.dataDir, "watch.json"), "utf8")).toBe(
      "{broken",
    );
    f.store.close();
  });
});

it("rejects incomplete jobs/watch/queue before any activation", async () => {
  for (const target of ["job", "watch", "queue"]) {
    const f = fixture();
    const file =
      target === "job"
        ? path.join(f.outputRoot, "moved", "job.json")
        : path.join(f.dataDir, `${target}.json`);
    const invalid =
      target === "job"
        ? { id: "j", dir: "moved", clips: [{ n: 1 }] }
        : target === "watch"
          ? { channels: [{ id: "c" }], maxPerDay: 6, intervalMin: 60 }
          : [{ key: "q" }];
    writeFileSync(file, JSON.stringify(invalid));
    await expect(importLegacy(f)).rejects.toThrow("corrupt");
    expect(f.store.list("legacy-jobs")).toHaveLength(0);
    f.store.close();
  }
});
it("changed/corrupt recovery originals report diagnostics without blocking durable state or adding snapshots", async () => {
  const f = fixture();
  await importLegacy(f);
  const source = path.join(f.outputRoot, "moved", "job.json");
  const marker = f.store.db
    .prepare("SELECT * FROM imports WHERE source=?")
    .get(source);
  const backups = readdirSync(path.join(f.dataDir, "legacy-backups"));
  writeFileSync(source, "{broken");
  const repeat = await importLegacy(f);
  expect(repeat.diagnostics).toContainEqual(
    expect.objectContaining({ file: source, status: "corrupt-recovery" }),
  );
  expect(f.store.get("legacy-jobs", "j")).toBeDefined();
  expect(
    f.store.db.prepare("SELECT * FROM imports WHERE source=?").get(source),
  ).toEqual(marker);
  expect(readdirSync(path.join(f.dataDir, "legacy-backups"))).toEqual(backups);
  f.store.close();
});
it("empty inventory creates no permanent snapshot", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "capy-empty-"));
  const store = openStore(dataDir);
  const report = await importLegacy({
    store,
    dataDir,
    outputRoot: path.join(dataDir, "out"),
  });
  expect(report.backupLocation).toBeNull();
  expect(existsSync(path.join(dataDir, "legacy-backups"))).toBe(false);
  store.close();
});
