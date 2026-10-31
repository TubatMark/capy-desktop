import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KEEP_UNFINISHED_MS, removeWorkspace, sweepable, sweepScratch } from "../server/worker/scratch";

const NOW = 2_000_000_000_000;

describe("worker scratch cleanup", () => {
  it("removes finished work at once and keeps active work however old", () => {
    const old = NOW - KEEP_UNFINISHED_MS - 1;
    const status: Record<string, "complete" | "cancelled" | "running" | "queued" | "retryable" | "blocked" | "needs_action"> = {
      a: "complete",
      b: "cancelled",
      c: "running",
      d: "queued",
      e: "retryable",
      f: "blocked",
      g: "needs_action",
      h: "needs_action",
    };
    const entries = [...Object.keys(status), "orphan-old", "orphan-new"].map((id) => ({
      id,
      mtimeMs: id === "h" || id === "orphan-new" ? NOW : old,
    }));
    entries.find((e) => e.id === "a")!.mtimeMs = NOW;
    expect(sweepable(entries, (id) => status[id], NOW).sort()).toEqual(["a", "b", "g", "orphan-old"]);
  });

  it("touches only the named workspace, never a job folder", () => {
    const root = mkdtempSync(path.join(tmpdir(), "capy-scratch-"));
    mkdirSync(path.join(root, ".worker", "done", "1"), { recursive: true });
    mkdirSync(path.join(root, ".worker", "live", "1"), { recursive: true });
    mkdirSync(path.join(root, "job-folder"), { recursive: true });
    writeFileSync(path.join(root, "job-folder", "clip.mp4"), "keep");
    const count = sweepScratch(root, (id) => (id === "done" ? "complete" : "running"), Date.now(), true);
    expect(count).toBe(1);
    expect(existsSync(path.join(root, ".worker", "done"))).toBe(false);
    expect(existsSync(path.join(root, ".worker", "live"))).toBe(true);
    expect(existsSync(path.join(root, "job-folder", "clip.mp4"))).toBe(true);
  });

  it("refuses ids that could leave the scratch folder", () => {
    const root = mkdtempSync(path.join(tmpdir(), "capy-scratch-"));
    mkdirSync(path.join(root, ".worker"), { recursive: true });
    writeFileSync(path.join(root, "keep.txt"), "keep");
    for (const id of ["..", ".", "../..", "a/../..", ""]) removeWorkspace(root, id);
    expect(existsSync(path.join(root, "keep.txt"))).toBe(true);
    expect(existsSync(path.join(root, ".worker"))).toBe(true);
  });
});

describe("old tick records", () => {
  it("removes finished ticks only, keeping job history and anything recent or unfinished", async () => {
    const { Store } = await import("../server/db");
    const { pruneTicks, KEEP_TICKS_MS } = await import("../server/worker/scratch");
    const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), "capy-prune-")), "s.sqlite"));
    const old = NOW - KEEP_TICKS_MS - 1;
    const put = (id: string, kind: string, status: string, createdAt: number, workKey = "k") => store.put("work", id, { kind, status, createdAt, workKey });
    put("old-poster", "poster", "complete", old);
    put("old-watcher", "watcher", "complete", old);
    put("old-observe", "longform-upload", "complete", old, "longform:observe");
    put("old-upload", "longform-upload", "complete", old, "longform:a:upload:0");
    put("old-media", "media", "complete", old);
    put("new-poster", "poster", "complete", NOW);
    put("stuck-poster", "poster", "queued", old);
    pruneTicks(store.db as never, NOW, true);
    expect(store.list("work").map((r) => r.id).sort()).toEqual(["new-poster", "old-media", "old-upload", "stuck-poster"]);
  });
});
