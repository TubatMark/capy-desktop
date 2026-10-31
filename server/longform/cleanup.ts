import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { LongVideo } from "../../lib/longform";
import { OUTPUT_ROOT } from "../paths";
import { LONG_FOLDER, getVideo, patchVideo, queueEntries, videoDir } from "./store";

/** A problem usually shows up soon after processing; wait before local copies go. */
export const HOLD_MS = 48 * 3600_000;
/** Statuses where a Short still needs its files. */
const FINISHED_SHORT = new Set(["posted", "rejected"]);

export interface CleanupPlan {
  allowed: boolean;
  /** Why it isn't available yet. */
  blocked?: string;
  files: { path: string; bytes: number }[];
  kept: { path: string; why: string }[];
  bytes: number;
}

function folderFiles(dir: string): { path: string; bytes: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return folderFiles(p);
    return e.isFile() ? [{ path: path.relative(OUTPUT_ROOT, p), bytes: statSync(p).size }] : [];
  });
}

export function cleanupBlock(v: LongVideo, now: number): string | undefined {
  if (v.status === "freed") return "Already freed";
  if (!v.youtube?.id) return "Not uploaded yet";
  if (v.youtube.rejected) return `YouTube rejected this video: ${v.youtube.rejected}`;
  if (!v.youtube.processedAt) return "YouTube hasn't finished processing it";
  const left = v.youtube.processedAt + HOLD_MS - now;
  if (left > 0) return `Available in ${Math.ceil(left / 3600_000)} hours, once 48 hours have passed since processing`;
  return undefined;
}

/**
 * Exactly what would go. Used footage goes only if its Short was posted or expired; a video's own folder always goes.
 * Transcripts, titles and finished Shorts stay.
 */
export function cleanupPlan(v: LongVideo, now = Date.now(), entries = queueEntries()): CleanupPlan {
  const files = folderFiles(videoDir(v.id));
  const kept: CleanupPlan["kept"] = [];
  for (const c of v.clips) {
    const abs = path.join(OUTPUT_ROOT, c.file);
    if (!existsSync(abs)) continue;
    const entry = entries.filter((e) => e.jobId === c.jobId && e.n === c.n);
    if (!entry.length || entry.some((e) => !FINISHED_SHORT.has(e.status))) {
      kept.push({ path: c.file, why: entry.length ? "Its Short is still waiting to post" : "Its Short hasn't been posted" });
      continue;
    }
    files.push({ path: c.file, bytes: statSync(abs).size });
  }
  const blocked = cleanupBlock(v, now);
  return { allowed: !blocked, blocked, files, kept, bytes: files.reduce((a, f) => a + f.bytes, 0) };
}

/** Only source footage in a job's work folder, or this video's own folder. Anything else is refused. */
export function isRemovable(rel: string, id: string): boolean {
  const abs = path.resolve(OUTPUT_ROOT, rel);
  if (!abs.startsWith(OUTPUT_ROOT + path.sep)) return false;
  const parts = path.relative(OUTPUT_ROOT, abs).split(path.sep);
  if (parts[0] === LONG_FOLDER) return parts[1] === id && parts.length > 2;
  return parts.length === 3 && parts[0] !== ".worker" && parts[1] === "work" && parts[2]!.endsWith(".src.mp4");
}

/** Runs on the owner's click, after they saw the plan. Works the list out again rather than trusting an earlier one. */
export function freeSpace(id: string, now = Date.now()): LongVideo {
  const v = getVideo(id);
  if (!v) throw new Error("That video no longer exists");
  const plan = cleanupPlan(v, now);
  if (!plan.allowed) throw new Error(plan.blocked);
  let removed = 0;
  let bytes = 0;
  for (const f of plan.files) {
    if (!isRemovable(f.path, id)) throw new Error(`Refusing to delete ${f.path}`);
    rmSync(path.join(OUTPUT_ROOT, f.path), { force: true });
    removed++;
    bytes += f.bytes;
  }
  rmSync(videoDir(id), { recursive: true, force: true });
  return patchVideo(id, { status: "freed", master: undefined, thumb: undefined, freed: { at: now, bytes, files: removed } });
}
