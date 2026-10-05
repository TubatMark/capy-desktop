import { existsSync } from "node:fs";
import { audienceTz as tzOf } from "../lib/post-time";
import type { ClipState, JobState, Platform, QueueEntry } from "../lib/types";
import { AuthError, loadAccounts, publicAccounts, saveAccount } from "./accounts";
import { postInstagram } from "./platforms/instagram";
import { postTikTok } from "./platforms/tiktok";
import { PlatformError, type PostJob, type PostOutcome } from "./platforms/types";
import { postYouTube } from "./platforms/youtube";
import { markResult, note, patch, queue, reconcileMissed, upsertForRender } from "./queue";
import { effective } from "./settings";

/**
 * Posts due queue entries. Runs inside the app's server (started from instrumentation.ts), so it posts while
 * capy is open or sitting in the menu bar. One upload at a time per platform.
 */

export interface PosterDeps {
  now(): Date;
  post(e: QueueEntry, job: PostJob, token: string): Promise<PostOutcome>;
  token(p: Platform): Promise<string>;
  fileFor(e: QueueEntry): { file: string; thumbFile?: string } | undefined;
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

function defaultDeps(): PosterDeps {
  return {
    now: () => new Date(),
    paused: () => effective().postingPaused,
    audienceTz: () => tzOf(effective().postingAudience),
    flagReconnect: (p) => void saveAccount(p, { needsReconnect: true }),
    token: async (p) => (await import("./accounts")).getAccessToken(p),
    fileFor: (e) => {
      // the job manager is loaded lazily: it imports this module for onRendered
      const { jobs, renderedFile } = require("./jobs") as typeof import("./jobs");
      const job = jobs().get(e.jobId);
      const c = job?.clips.find((x) => x.n === e.n);
      const file = job && c ? renderedFile(job, c) : undefined;
      if (!file) return undefined;
      const thumb = file.replace(/\.mp4$/, ".jpg");
      return { file, thumbFile: existsSync(thumb) ? thumb : undefined };
    },
    post: async (e, job, token) => {
      const ctx = { token, fetch, sleep, log: (m: string) => console.log(`[poster] ${e.platform} ${e.key}: ${m}`) };
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
  const now = d.now();
  const { busy } = state();
  const due: QueueEntry[] = [];
  queue().mutate((entries) => {
    let out = reconcileMissed(entries, d.audienceTz(), now);
    const picked = new Set<Platform>();
    for (const e of out.filter((x) => isDue(x, now.getTime())).sort((a, b) => (a.nextTryAt ?? a.slotAt ?? 0) - (b.nextTryAt ?? b.slotAt ?? 0))) {
      if (busy.has(e.platform) || picked.has(e.platform)) continue;
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
        const f = d.fileFor(e);
        if (!f) {
          queue().mutate((all) => patch(all, e.key, (x) => note({ ...x, status: "needs_action", error: "Clip file missing, re-render it" }, "Clip file missing, re-render it", d.now())));
          return;
        }
        let r: Parameters<typeof markResult>[2];
        try {
          const token = await d.token(e.platform);
          r = { outcome: await d.post(e, { file: f.file, thumbFile: f.thumbFile, thumbAt: e.thumbAt, text: e.text }, token) };
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
  if (s.timer) return;
  const run = () => void tick().catch((e) => console.error("[poster]", e));
  setTimeout(run, 5_000);
  s.timer = setInterval(run, 30_000);
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
        jobId: job.id,
        n: c.n,
        clipTitle: c.title,
        videoTitle: job.title,
        videoUrl: c.render.url,
        thumbUrl: c.render.thumbUrl ?? (c.render.file ? toMediaUrl(c.render.file.replace(/\.mp4$/, ".jpg")) : undefined),
        thumbAt: c.thumbAt,
        publish: c.publish,
        hook: c.hook,
      },
      platforms,
      new Date(),
    ),
  );
}
