import { eligibility } from "./publication-policy";
import { existsSync } from "node:fs";
import { audienceTz as tzOf } from "../lib/post-time";
import type { ClipState, JobState, Platform, QueueEntry } from "../lib/types";
import { AuthError, loadAccounts, publicAccounts, saveAccount } from "./accounts";
import { postInstagram } from "./platforms/instagram";
import { postTikTok } from "./platforms/tiktok";
import { PlatformError, type PostJob, type PostOutcome } from "./platforms/types";
import { postYouTube } from "./platforms/youtube";
import { fingerprint, markResult, note, patch, queue, reconcileMissed, recoverInterrupted, upsertForRender } from "./queue";
import { dataDir, effective } from "./settings";
import { takePosterLock } from "./poster-lock";
import path from "node:path";

/**
 * Posts due queue entries. Runs inside the app's server (started by the job manager and the queue routes, never from
 * instrumentation.ts: its file trace isn't covered by outputFileTracingExcludes and pulled the whole project, videos
 * included, into the packaged app), so it posts while
 * capy is open or sitting in the menu bar. One upload at a time per platform.
 */

/** Where the entry's clip stands right now. */
export type ClipFile = { file: string; thumbFile?: string } | "missing" | "changed" | "rendering";

export interface PosterDeps {
  now(): Date;
  post(e: QueueEntry, job: PostJob, token: string, checkpoint: (p: Record<string, string>) => void): Promise<PostOutcome>;
  token(p: Platform): Promise<string>;
  fileFor(e: QueueEntry): Promise<ClipFile>;
  /** One poster per data folder (see poster-lock.ts). */
  lock(): "acquired" | "held" | "busy";
  paused(): boolean;
  audienceTz(): string;
  /** The platform refused the token: mark the account so Settings asks to reconnect. */
  flagReconnect?(p: Platform): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __capyPoster: { timer?: NodeJS.Timeout; busy: Set<Platform> } | undefined;
}
const state = () => (globalThis.__capyPoster ??= { busy: new Set<Platform>() });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const resolvePublicationFiles = async (e: QueueEntry): Promise<ClipFile> => e.publicationFiles && existsSync(e.publicationFiles.file) ? e.publicationFiles : defaultDeps().fileFor(e);

function defaultDeps(): PosterDeps {
  return {
    now: () => new Date(),
    paused: () => effective().postingPaused,
    audienceTz: () => tzOf(effective().postingAudience),
    flagReconnect: (p) => void saveAccount(p, { needsReconnect: true }),
    token: async (p) => (await import("./accounts")).getAccessToken(p),
    lock: () => takePosterLock(path.join(dataDir(), "poster.lock"), Date.now()),
    fileFor: async (e) => {
      if (e.jobId.startsWith("story-")) {
        const { stories, storyClipFile } = await import("./stories");
        await stories().init();
        return storyClipFile(stories().getStory(e.jobId.slice("story-".length)), e);
      }
      // the job manager is loaded lazily (it imports this module for onRendered), and must have read the jobs from disk
      const { jobs, renderedFile } = await import("./jobs");
      await jobs().init();
      const job = jobs().get(e.jobId);
      const c = job?.clips.find((x) => x.n === e.n);
      if (!job || !c) return "missing";
      if (e.fp && fingerprint(c.start, c.end) !== e.fp) return "changed";
      if (c.render.status === "queued" || c.render.status === "rendering") return "rendering";
      const file = renderedFile(job, c);
      if (!file) return "missing";
      const thumb = file.replace(/\.mp4$/, ".jpg");
      return { file, thumbFile: existsSync(thumb) ? thumb : undefined };
    },
    post: async (e, job, token, checkpoint) => {
      const ctx = { token, fetch, sleep, checkpoint, log: (m: string) => console.log(`[poster] ${e.platform} ${e.key}: ${m}`) };
      const a = loadAccounts()[e.platform];
      if (e.platform === "youtube") return postYouTube(job, ctx);
      if (e.platform === "instagram") {
        if (!a.igUserId) throw new AuthError("Pick the Instagram account to post as in Settings → Accounts");
        return postInstagram(job, { ...ctx, igUserId: a.igUserId });
      }
      return postTikTok(job, { ...ctx, mode: a.mode ?? "inbox", username: (a.account as { username?: string } | undefined)?.username });
    },
  };
}

const isDue = (e: QueueEntry, now: number) =>
  (e.status === "scheduled" && e.slotAt !== undefined && e.slotAt <= now) || (e.status === "failed" && e.nextTryAt !== undefined && e.nextTryAt <= now);

/** One pass: reschedule missed slots, then post every due entry (one per platform). */
export async function tick(d: PosterDeps = defaultDeps()): Promise<void> {
  if (d.paused()) return;
  const lock = d.lock();
  if (lock === "busy") return; // another capy process posts for this data folder
  const now = d.now();
  // newly the poster for this folder: whatever was "posting" was cut off when the previous poster stopped
  if (lock === "acquired") queue().mutate((all) => recoverInterrupted(all, now));
  const { busy } = state();
  const due: QueueEntry[] = [];
  queue().mutate((entries) => {
    let out = reconcileMissed(entries, d.audienceTz(), now);
    const picked = new Set<Platform>();
    for (const e of out.filter((x) => isDue(x, now.getTime())).sort((a, b) => (a.nextTryAt ?? a.slotAt ?? 0) - (b.nextTryAt ?? b.slotAt ?? 0))) {
      if (busy.has(e.platform) || picked.has(e.platform)) continue;
      const allowed = eligibility(e);
      if (!allowed.allowed) {
        out = patch(out, e.key, x => note({...x,status:"review",slotAt:undefined,nextTryAt:undefined,error:allowed.reasons.join("; ")},allowed.reasons.join("; "),now));
        continue;
      }
      picked.add(e.platform);
      due.push(e);
    }
    for (const e of due) out = patch(out, e.key, (x) => note({ ...x, status: "posting" }, "Posting…", now));
    return out;
  });
  for (const e of due) busy.add(e.platform);
  await Promise.all(
    due.map(async (e) => {
      try {
        const f = await d.fileFor(e);
        const stop = (msg: string) => queue().mutate((all) => patch(all, e.key, (x) => note({ ...x, status: "needs_action", error: msg }, msg, d.now())));
        if (f === "rendering") {
          // it's being re-rendered: post the new file on a later tick
          queue().mutate((all) => patch(all, e.key, (x) => ({ ...x, status: "scheduled" })));
          return;
        }
        if (f === "missing") return void stop("Clip file missing, re-render it");
        if (f === "changed") return void stop("This clip changed after you approved it. Render it again to review the new cut.");
        const checkpoint = (p: Record<string, string>) => void queue().mutate((all) => patch(all, e.key, (x) => ({ ...x, progress: { ...x.progress, ...p } })));
        let r: Parameters<typeof markResult>[2];
        try {
          const token = await d.token(e.platform);
          // Re-read durable state after token refresh, then hash actual upload bytes immediately before upload.
          const current = queue().list().find(x => x.key === e.key);
          if (!current || current.status !== "posting") return;
          const result = eligibility(current, f);
          if (!result.allowed) return void stop(result.reasons.join("; "));
          r = { outcome: await d.post(e, { file: f.file, thumbFile: f.thumbFile, thumbAt: e.thumbAt, text: e.text, resume: e.progress, madeForKids: e.madeForKids }, token, checkpoint) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof AuthError) r = { error: { message, retryable: false, auth: true } };
          else if (err instanceof PlatformError) {
            r = { error: { message, retryable: err.retryable, auth: err.auth } };
            if (err.auth) d.flagReconnect?.(e.platform);
          }
          else r = { error: { message, retryable: true, auth: false } };
        }
        queue().mutate((all) => markResult(all, e.key, r, d.now()));
      } finally {
        busy.delete(e.platform);
      }
    }),
  );
}

/** Start the 30-second loop once per server process. */
export function startPoster() {
  const s = state();
  // route modules are also loaded by `next build` workers: never post from a build
  if (s.timer || process.env.NEXT_PHASE === "phase-production-build") return;
  const run = () => void tick().catch((e) => console.error("[poster]", e));
  setTimeout(run, 5_000).unref();
  s.timer = setInterval(run, 30_000);
  s.timer.unref(); // never the only thing keeping a process alive (tests, CLI)
}

/** A clip finished rendering: queue it for review on every connected platform with auto-post on. */
export function onRendered(job: JobState, c: ClipState, toMediaUrl: (abs: string) => string) {
  if (job.settings.autoPost === false || c.render.status !== "done" || !c.render.file) return;
  const platforms = publicAccounts()
    .filter((a) => a.connected && a.autoPost)
    .map((a) => a.platform);
  if (!platforms.length) return;
  queue().mutate((e) =>
    upsertForRender(
      e,
      {
        publicationFiles: {file:c.render.file!,thumbFile:existsSync(c.render.file!.replace(/\.mp4$/, ".jpg")) ? c.render.file!.replace(/\.mp4$/, ".jpg") : undefined},
        jobId: job.id,
        n: c.n,
        start: c.start,
        end: c.end,
        clipTitle: c.title,
        videoTitle: job.title,
        videoUrl: c.render.url,
        thumbUrl: c.render.thumbUrl ?? (c.render.file ? toMediaUrl(c.render.file.replace(/\.mp4$/, ".jpg")) : undefined),
        thumbAt: c.thumbAt,
        publish: c.publish,
        hook: c.hook,
        aiReview: c.contentReview,
        seo: c.seo,
      },
      platforms,
      new Date(),
    ),
  );
}
