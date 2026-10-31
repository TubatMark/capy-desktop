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

/** Footage nothing is using is kept this long for long-form to draw on; a stale moment makes a stale compilation anyway. */
export const FOOTAGE_KEEP_MS = 14 * 86400_000;

interface FootageJob extends Job {
  dir?: string;
  createdAt?: number;
  clips?: { n: number; render?: { status?: string; file?: string }; segment?: { url?: string } }[];
}

/** Old footage of clips no Short is waiting on and no unfinished long video has claimed. */
export function removableFootage(jobs: FootageJob[], entries: Entry[], claimed: Set<string>, now: number): string[] {
  const active = new Set(entries.filter((e) => e.status !== "posted" && e.status !== "rejected").map(key));
  const out: string[] = [];
  for (const job of jobs) {
    if (!job.createdAt || now - job.createdAt < FOOTAGE_KEEP_MS) continue;
    for (const c of job.clips ?? []) {
      const url = c.segment?.url;
      if (!url || active.has(`${job.id}:${c.n}`) || claimed.has(`${job.id}:${c.n}`)) continue;
      const rel = decodeURIComponent(url.replace(/^\/api\/media\//, "").split("?")[0]!);
      const parts = rel.split("/");
      if (parts.length === 3 && parts[1] === "work" && !parts[0]!.startsWith(".") && parts[2]!.endsWith(".src.mp4")) out.push(rel);
    }
  }
  return out;
}

export function removeOldFootage(now = Date.now()): { files: number; bytes: number } {
  const store = runtimeStore();
  const claimed = new Set(
    store
      .list<{ status: string; clips?: { jobId: string; n: number }[] }>("longform-videos")
      .filter((r) => r.value.status !== "freed")
      .flatMap((r) => (r.value.clips ?? []).map((c) => `${c.jobId}:${c.n}`)),
  );
  let files = 0;
  let bytes = 0;
  for (const rel of removableFootage(store.list<FootageJob>("legacy-jobs").map((r) => r.value), queueEntries(), claimed, now)) {
    const abs = path.join(OUTPUT_ROOT, rel);
    if (!existsSync(abs)) continue;
    bytes += statSync(abs).size;
    rmSync(abs, { force: true });
    files++;
  }
  return { files, bytes };
}
