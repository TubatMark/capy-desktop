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
