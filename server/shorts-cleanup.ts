import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { runtimeStore } from "./db/runtime";
import { OUTPUT_ROOT } from "./paths";

/** Rendered Shorts are only needed until they're safely on YouTube. Footage, transcripts and thumbnails stay. */
export const SHORT_HOLD_MS = 48 * 3600_000;

interface Entry {
  jobId?: string;
  n?: number;
  status: string;
  slotAt?: number;
  updatedAt?: number;
  source?: unknown;
}
interface Job {
  id: string;
  clips?: { n: number; render?: { status?: string; file?: string } }[];
}

const queueEntries = () => runtimeStore().get<Entry[]>("legacy-state", "queue")?.value ?? [];
const key = (e: Entry) => `${e.jobId}:${e.n}`;

/** Clips whose every post is finished, with at least one posted, and when the last one went out. */
function finished(entries: Entry[]): Map<string, number> {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) if (e.jobId && e.n !== undefined && !e.source) groups.set(key(e), [...(groups.get(key(e)) ?? []), e]);
  const out = new Map<string, number>();
  for (const [k, es] of groups) {
    const posted = es.filter((e) => e.status === "posted");
    if (posted.length && es.every((e) => e.status === "posted" || e.status === "rejected")) out.set(k, Math.max(...posted.map((e) => e.slotAt ?? e.updatedAt ?? Infinity)));
  }
  return out;
}

/** Only a job's own rendered mp4: never footage in work/, scratch or long-form files. */
export function isRenderedShort(file: string, root = OUTPUT_ROOT): boolean {
  const parts = path.relative(root, path.resolve(file)).split(path.sep);
  return parts.length === 2 && !parts[0]!.startsWith(".") && parts[0] !== ".." && parts[1]!.endsWith(".mp4") && !parts[1]!.endsWith(".src.mp4");
}

export function removableShorts(jobs: Job[], entries: Entry[], now: number, root = OUTPUT_ROOT): string[] {
  const done = finished(entries);
  const out: string[] = [];
  for (const job of jobs)
    for (const c of job.clips ?? []) {
      const at = done.get(`${job.id}:${c.n}`);
      const file = c.render?.file;
      if (at === undefined || now - at < SHORT_HOLD_MS || c.render?.status !== "done" || !file || !isRenderedShort(file, root)) continue;
      out.push(file);
    }
  return out;
}

/** A missing file is expected for these, not an error to repair. */
export const shortFinishedPosting = (jobId: string, n: number) => finished(queueEntries()).has(`${jobId}:${n}`);

export function removeOldShorts(now = Date.now()): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const jobs = runtimeStore().list<Job>("legacy-jobs").map((r) => r.value);
  for (const file of removableShorts(jobs, queueEntries(), now)) {
    if (!existsSync(file)) continue;
    bytes += statSync(file).size;
    rmSync(file, { force: true });
    files++;
  }
  return { files, bytes };
}
