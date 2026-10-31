import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_SLOTS,
  FINISHED_PER_RAW,
  MAX_LONG_CLIPS,
  MIN_LONG_SECONDS,
  TARGET_LONG_SECONDS,
  creatorName,
  rankValue,
  type AudienceReport,
  type CreatorFootage,
  type LongClip,
  type LongVideo,
  type UploadSlot,
} from "../../lib/longform";
import type { Word } from "../../src/types";
import { runtimeStore } from "../db/runtime";
import { OUTPUT_ROOT } from "../paths";

const KIND = "longform-videos";
const CONFIG = "longform-config";
/** Everything a long video writes lives here, away from the clip jobs. */
export const LONG_FOLDER = ".long-form";
export const videoDir = (id: string) => path.join(OUTPUT_ROOT, LONG_FOLDER, id);

export const listVideos = (): LongVideo[] =>
  runtimeStore()
    .list<LongVideo>(KIND)
    .map((r) => r.value)
    .sort((a, b) => b.createdAt - a.createdAt);
export const getVideo = (id: string) => runtimeStore().get<LongVideo>(KIND, id)?.value;
export function saveVideo(v: LongVideo) {
  const next = { ...v, updatedAt: Date.now() };
  runtimeStore().put(KIND, v.id, next);
  return next;
}
export function patchVideo(id: string, patch: Partial<LongVideo>): LongVideo {
  return runtimeStore().transaction(() => {
    const cur = getVideo(id);
    if (!cur) throw new Error("That video no longer exists");
    return saveVideo({ ...cur, ...patch });
  });
}
export function removeVideo(id: string) {
  runtimeStore().db.prepare("DELETE FROM documents WHERE kind=? AND id=?").run(KIND, id);
  if (id && id === path.basename(id)) rmSync(videoDir(id), { recursive: true, force: true });
}

export const loadSlots = (): UploadSlot[] => runtimeStore().get<UploadSlot[]>(CONFIG, "slots")?.value ?? DEFAULT_SLOTS;
export const saveSlots = (slots: UploadSlot[]) => runtimeStore().put(CONFIG, "slots", slots);
/** Moments the screening turned down, so they aren't offered again. */
const skipped = () => runtimeStore().get<string[]>(CONFIG, "skipped")?.value ?? [];
export const skipClips = (keys: string[]) => runtimeStore().put(CONFIG, "skipped", [...new Set([...skipped(), ...keys])]);
export const loadAudience = () => runtimeStore().get<AudienceReport>(CONFIG, "audience")?.value;
export const saveAudience = (a: AudienceReport) => runtimeStore().put(CONFIG, "audience", a);

// ---------- footage ----------

interface RawClip {
  n: number;
  start: number;
  end: number;
  title?: string;
  reason?: string;
  hook?: string;
  score?: number;
  segment?: { start: number; end: number; url?: string; status?: string };
  contentReview?: { verdict?: string };
}
interface RawJob {
  id: string;
  dir?: string;
  title?: string;
  channel?: string;
  url?: string;
  language?: string;
  sourceLang?: string;
  clips?: RawClip[];
}
interface RawQueueEntry {
  jobId?: string;
  n?: number;
  status: string;
  result?: { id?: string };
}

export const queueEntries = () => runtimeStore().get<RawQueueEntry[]>("legacy-state", "queue")?.value ?? [];

const mediaRel = (url: string) => decodeURIComponent(url.replace(/^\/api\/media\//, "").split("?")[0]!);
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / Math.max(1, Math.min(a.end - a.start, b.end - b.start));

/** Keep a bit of air around the moment, as far as the footage reaches. */
export const clipWindow = (c: Pick<LongClip, "start" | "end" | "segStart" | "segEnd">) => ({
  start: Math.max(c.segStart, c.start - 1.5),
  end: Math.min(c.segEnd, c.end + 1.5),
});

/** Every usable moment that hasn't gone into a long video: landscape footage on disk, not blocked, no overlaps. */
export function availableClips(viewsOf: (videoId: string) => number | undefined = () => undefined): LongClip[] {
  const used = new Set([...skipped(), ...listVideos().flatMap((v) => v.clips.map((c) => `${c.jobId}:${c.n}`))]);
  const posted = new Map(queueEntries().filter((e) => e.result?.id).map((e) => [`${e.jobId}:${e.n}`, e.result!.id!]));
  const out: LongClip[] = [];
  for (const { value: job } of runtimeStore().list<RawJob>("legacy-jobs")) {
    if (!job.dir || !job.channel || !existsSync(path.join(OUTPUT_ROOT, job.dir, "words.json"))) continue;
    if (!/^en/i.test(job.sourceLang ?? job.language ?? "en")) continue;
    const kept: LongClip[] = [];
    const clips = [...(job.clips ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const c of clips) {
      if (used.has(`${job.id}:${c.n}`)) continue;
      if (c.contentReview?.verdict === "block" || c.segment?.status !== "done" || !c.segment.url) continue;
      const file = mediaRel(c.segment.url);
      if (!file.endsWith(".src.mp4") || !existsSync(path.join(OUTPUT_ROOT, file))) continue;
      if (kept.some((k) => overlap(k, c) > 0.5)) continue;
      const id = posted.get(`${job.id}:${c.n}`);
      kept.push({
        jobId: job.id,
        n: c.n,
        file,
        segStart: c.segment.start,
        segEnd: c.segment.end,
        start: c.start,
        end: c.end,
        title: c.title ?? job.title ?? "",
        reason: c.reason,
        hook: c.hook,
        score: c.score ?? 0,
        views: id ? viewsOf(id) : undefined,
        channel: job.channel,
        sourceTitle: job.title ?? "",
        sourceUrl: job.url ?? "",
      });
    }
    out.push(...kept);
  }
  return out;
}

const clipSeconds = (c: LongClip) => {
  const w = clipWindow(c);
  return Math.max(0, w.end - w.start);
};

export function footageByCreator(clips: LongClip[]): CreatorFootage[] {
  const groups = new Map<string, LongClip[]>();
  for (const c of clips) groups.set(creatorName(c.channel), [...(groups.get(creatorName(c.channel)) ?? []), c]);
  return [...groups]
    .map(([creator, list]) => {
      const rawSeconds = Math.round(list.reduce((a, c) => a + clipSeconds(c), 0));
      const pick = list.sort((a, b) => rankValue(b) - rankValue(a)).slice(0, MAX_LONG_CLIPS);
      const estimateSeconds = Math.round(Math.min(TARGET_LONG_SECONDS * 1.35, pick.reduce((a, c) => a + clipSeconds(c), 0) * FINISHED_PER_RAW));
      return { creator, clips: list.length, rawSeconds, estimateSeconds, enough: estimateSeconds >= MIN_LONG_SECONDS };
    })
    .sort((a, b) => b.rawSeconds - a.rawSeconds);
}

/** Add to `start` until the target length, then order from the lowest rank to number one. */
export function fillClips(start: LongClip[], more: LongClip[], creator: string): LongClip[] {
  const chosen = [...start];
  let seconds = chosen.reduce((a, c) => a + clipSeconds(c) * FINISHED_PER_RAW, 0);
  for (const c of more.filter((x) => creatorName(x.channel) === creator).sort((a, b) => rankValue(b) - rankValue(a))) {
    if (chosen.length >= MAX_LONG_CLIPS || seconds >= TARGET_LONG_SECONDS) break;
    chosen.push(c);
    seconds += clipSeconds(c) * FINISHED_PER_RAW;
  }
  if (seconds < MIN_LONG_SECONDS) throw new Error(`${creator} has about ${Math.round(seconds / 60)} minutes of usable footage. A long video needs at least ${MIN_LONG_SECONDS / 60}.`);
  return chosen.sort((a, b) => rankValue(a) - rankValue(b));
}
export const pickClips = (all: LongClip[], creator: string) => fillClips([], all, creator);

export function createVideo(creator: string, viewsOf?: (videoId: string) => number | undefined): LongVideo {
  const now = Date.now();
  return saveVideo({
    id: randomUUID(),
    creator,
    status: "draft",
    title: `Top moments: ${creator}`,
    clips: pickClips(availableClips(viewsOf), creator),
    createdAt: now,
    updatedAt: now,
  });
}

export function wordsFor(c: LongClip): Word[] {
  const dir = c.file.split("/")[0]!;
  const words = JSON.parse(readFileSync(path.join(OUTPUT_ROOT, dir, "words.json"), "utf8")) as Word[];
  const w = clipWindow(c);
  return words.filter((x) => x.end > w.start && x.start < w.end);
}

export const fileSize = (rel?: string) => {
  try {
    return rel ? statSync(path.join(OUTPUT_ROOT, rel)).size : 0;
  } catch {
    return 0;
  }
};
