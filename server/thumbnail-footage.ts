import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ThumbnailSourceRef } from "../lib/thumbnails";
import type { JobState } from "../lib/types";
import type { Store } from "./db";

/**
 * Whether a thumbnail's footage is still what it was made from. A Studio project is its own document, so its
 * revision decides. A clip of a video is judged by that clip alone: rendered, and its file still the bytes the
 * design was made from. The video job's revision moves whenever any of its clips renders or a field is saved,
 * which would otherwise mark the other clips' thumbnails stale (3 clips per upload made that constant).
 */
export function footageCurrent(source: ThumbnailSourceRef, store: Store): boolean {
  if (source.kind === "project")
    return store.get<{ revision: number }>("projects", source.projectId)?.revision === source.revision;
  const clip = store
    .get<JobState>("legacy-jobs", source.jobId)
    ?.value.clips.find((c) => c.n === source.clipN);
  if (clip?.render.status !== "done" || !clip.render.file) return false;
  try {
    return createHash("sha256").update(readFileSync(clip.render.file)).digest("hex") === source.renderChecksum;
  } catch {
    return false;
  }
}
