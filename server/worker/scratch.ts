import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { JobRecord } from "./leases";

/**
 * `.worker/<lease id>` is scratch: pipeline stages copy what they finish into the job's own folder, so a finished
 * lease's workspace only holds duplicates. Nothing outside `.worker` is ever touched here.
 */
const SWEEP_EVERY_MS = 3600_000;
/** Failed or unknown work keeps its workspace this long, for retries and for reading what went wrong. */
export const KEEP_UNFINISHED_MS = 7 * 86400_000;
const DONE: JobRecord["status"][] = ["complete", "cancelled"];
/** Bounds one sweep so it can't hold up the worker loop. */
const MAX_PER_SWEEP = 500;

export function removeWorkspace(root: string, id: string) {
  if (!id || id !== path.basename(id) || id === "." || id === "..") return;
  rmSync(path.join(root, ".worker", id), { recursive: true, force: true });
}

/** Which workspaces can go: finished work at once; anything else only when old and not active. */
export function sweepable(
  entries: { id: string; mtimeMs: number }[],
  statusOf: (id: string) => JobRecord["status"] | undefined,
  now: number,
): string[] {
  return entries
    .filter((e) => {
      const status = statusOf(e.id);
      if (status && DONE.includes(status)) return true;
      if (status && status !== "needs_action") return false;
      return now - e.mtimeMs > KEEP_UNFINISHED_MS;
    })
    .map((e) => e.id);
}

let lastSweep = 0;

export function sweepScratch(
  root: string,
  statusOf: (id: string) => JobRecord["status"] | undefined,
  now = Date.now(),
  force = false,
): number {
  if (!force && now - lastSweep < SWEEP_EVERY_MS) return 0;
  lastSweep = now;
  const base = path.join(root, ".worker");
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  const entries = names.slice(0, 20_000).flatMap((id) => {
    try {
      return [{ id, mtimeMs: statSync(path.join(base, id)).mtimeMs }];
    } catch {
      return [];
    }
  });
  const ids = sweepable(entries, statusOf, now).slice(0, MAX_PER_SWEEP);
  for (const id of ids) removeWorkspace(root, id);
  return ids.length;
}
