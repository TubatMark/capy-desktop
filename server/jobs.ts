import { createHash } from "node:crypto";
import { validateLegacy } from "./db/legacy-validation";
import { runtimeStore } from "./db/runtime";
import { jobRepository } from "./repositories/jobs";
import { importLegacy } from "./db/import-legacy";
import { dataDir } from "./settings";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  copyFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { currentWork, fence, assertWork } from "./worker/context";
import { enqueueWork, workQueue } from "./worker/api";
import type { JobLease } from "./worker/leases";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  stageMeta,
  stageWords,
  stagePick,
  stageSegment,
  stageRender,
  segmentFor,
  exists,
  writePublishFiles,
  thumbCandidates,
} from "../src/pipeline";
import { thumbnail } from "../src/render";
import { pickCaptionLang, videoIdFromUrl } from "../src/youtube";
import { snapToWords, wordsInRange } from "../src/captions";
import { generatePublish, pickClips, rewriteTitleHook } from "../src/pick";
import { peakFor, replayPeaks } from "../src/heatmap";
import { applyReview, reviewPicks } from "../src/review";
import {
  coalesce,
  covers,
  mergeWords,
  phrasesToTranslate,
  translatePhrases,
} from "../src/translate";
import { isEnglish } from "../src/lang";
import { pool } from "../src/util";
import { CancelledError, isCancelled, throwIfCancelled } from "../src/exec";
import type { VideoMeta, Word } from "../src/types";
import { boot } from "./boot";
import { onRendered } from "./poster";
import { publicAccounts } from "./accounts";
import { markHistory, watch } from "./watch";

import { reviewContent, reviewUnavailable } from "../src/content-review";
import { tuneSeo } from "./seo";
import { scoreSeo } from "../src/seo/score";
import { cleanCaptionWords } from "../src/ass";
import { OUTPUT_ROOT, toMediaUrl } from "./paths";
import { effective } from "./settings";
import { loadTimings, learn, type Timings } from "./estimates";
import type {
  ClipState,
  ContentReview,
  JobSettings,
  JobState,
  Stage,
} from "../lib/types";
import { DEFAULT_SETTINGS } from "../lib/types";
import { looksEqual, normalizeLook } from "../lib/look";
import { agentSpec } from "../src/agents";

/**
 * Request processes read committed snapshots and enqueue operations. Only the worker
 * invokes the pipeline, using durable checkpoints and generation-scoped outputs.
 */
class JobManager extends EventEmitter {
  jobs = new Map<string, JobState>();
  words = new Map<string, Word[]>();
  private loaded = false;
  private loading?: Promise<void>;
  /** Video metadata per job (heatmap for replace), and translated caption words; lazy for the same reason. */
  private _metas?: Map<string, VideoMeta>;
  private get metas() {
    return (this._metas ??= new Map<string, VideoMeta>());
  }
  private _enWrites?: Promise<void>;
  private get enWrites() {
    return (this._enWrites ??= Promise.resolve());
  }
  private set enWrites(p: Promise<void>) {
    this._enWrites = p;
  }
  private _captionLoads?: Map<string, Promise<void>>;
  private get captionLoads() {
    return (this._captionLoads ??= new Map<string, Promise<void>>());
  }
  private _captionWords?: Map<string, Word[]>;
  private get captionWords() {
    return (this._captionWords ??= new Map<string, Word[]>());
  }

  /** Load every job from disk once. Concurrent callers (the SSE route and the first fetch land together) wait for the same load. */
  init(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    return (this.loading ??= this.load().then(() => {
      this.loaded = true;
    }));
  }

  private async load() {
    boot();
    await mkdir(OUTPUT_ROOT, { recursive: true });
    const report = await importLegacy({
      store: runtimeStore(),
      dataDir: dataDir(),
      outputRoot: OUTPUT_ROOT,
    });
    for (const diagnostic of report.diagnostics)
      console.warn("[legacy recovery]", diagnostic);
    const durableJobs = new Map(
      jobRepository(runtimeStore())
        .list()
        .map((job) => [job.dir, job]),
    );
    for (const d of new Set([
      ...durableJobs.keys(),
      ...(await readdir(OUTPUT_ROOT)),
    ])) {
      const job = durableJobs.get(d);
      if (!job) {
        const legacyFile = path.join(OUTPUT_ROOT, d, "job.json");
        if (existsSync(legacyFile))
          throw Error(`Legacy job was not activated: ${legacyFile}`);
        // Only a genuinely absent job.json can be treated as an older CLI run.
        const metaFile = path.join(OUTPUT_ROOT, d, "meta.json");
        if (!existsSync(metaFile)) continue;
        const imported = await this.importCliRun(d);
        if (imported) this.jobs.set(imported.id, imported);
        continue;
      }
      {
        // The durable worker owns recovery; request processes never reset live stages.
        let repaired = false;
        for (const c of job.clips) {
          // rendered files are stored as absolute paths; if the output folder moved (project renamed, drive
          // changed) find the file next to job.json, and if it is gone for good the clip is not rendered
          if (
            c.render.status === "done" &&
            c.render.file &&
            !existsSync(c.render.file)
          ) {
            const local = renderedFile(job, c);
            if (local) c.render.file = local;
            else {
              c.render = {
                ...c.render,
                error: "Media missing; relink the original file.",
              };
            }
            repaired = true;
          }
        }
        this.jobs.set(job.id, job);
        if (repaired) await this.save(job);
      }
    }
  }

  /** Turn a folder made by `pnpm clip` into a job the app can show and edit. */
  private async importCliRun(dir: string): Promise<JobState | null> {
    const abs = path.join(OUTPUT_ROOT, dir);
    const meta = JSON.parse(
      await readFile(path.join(abs, "meta.json"), "utf8"),
    );
    if (!meta?.id) return null;
    let clips: Array<{
      start: number;
      end: number;
      title: string;
      hook: string;
      reason: string;
      score: number;
      ytTitle?: string;
      description?: string;
      hashtags?: string[];
    }> = [];
    try {
      clips =
        JSON.parse(await readFile(path.join(abs, "clips.json"), "utf8"))
          .clips ?? [];
    } catch {
      /* picks not made yet */
    }
    const files = await readdir(abs);
    const stat = await import("node:fs/promises").then((m) => m.stat);
    const job: JobState = {
      id: meta.id,
      videoId: meta.id,
      url: meta.url ?? `https://www.youtube.com/watch?v=${meta.id}`,
      title: meta.title,
      channel: meta.channel,
      duration: meta.duration,
      language: meta.language,
      status: clips.length ? "ready" : "error",
      stage: "done",
      stageStartedAt: Date.now(),
      createdAt: (await stat(path.join(abs, "meta.json"))).mtimeMs,
      settings: { ...DEFAULT_SETTINGS },
      estimate: { stageRemaining: 0, totalRemaining: 0, progress: 1 },
      clips: clips.map((c, i) => {
        const n = i + 1;
        const rendered = files.find(
          (f) =>
            f.startsWith(`${String(n).padStart(2, "0")}-`) &&
            f.endsWith(".mp4"),
        );
        const rf = rendered ? path.join(abs, rendered) : undefined;
        const base = rf?.replace(/\.mp4$/, "");
        const hasThumb = base
          ? files.includes(path.basename(`${base}.jpg`))
          : false;
        return {
          ...c,
          n,
          selected: true,
          publish: c.ytTitle
            ? {
                ytTitle: c.ytTitle,
                description: c.description ?? "",
                hashtags: c.hashtags ?? [],
              }
            : undefined,
          // CLI segments are unpadded; the app will fetch padded ones when you open the editor
          render: rf
            ? {
                status: "done" as const,
                file: rf,
                url: workMediaUrl(rf),
                thumbUrl: hasThumb ? workMediaUrl(`${base}.jpg`) : undefined,
                textUrl: hasThumb ? workMediaUrl(`${base}.txt`) : undefined,
              }
            : { status: "none" as const },
        };
      }),
      log: [{ t: Date.now(), stage: "meta", msg: "imported from a CLI run" }],
      dir,
      wordCount: undefined,
      error: clips.length ? undefined : "No picks yet. Run it again.",
    };
    try {
      job.wordCount = JSON.parse(
        await readFile(path.join(abs, "words.json"), "utf8"),
      ).length;
      job.transcriptSource = "cache";
    } catch {
      /* no transcript */
    }
    await this.save(job);
    // fetch padded segments + thumbnails in the background so cards get pictures
    if (job.clips.length) await this.enqueue(job, "segments", []);
    return job;
  }

  private refresh() {
    if (currentWork()) return;
    for (const row of runtimeStore().list<JobState>("legacy-jobs")) {
      validateLegacy("legacy-jobs", row.id, row.value);
      const known = this.revisions.get(row.id);
      if (known !== row.revision) {
        this.jobs.set(row.id, row.value);
        this.revisions.set(row.id, row.revision);
        this.words.delete(row.id);
        this.captionWords.delete(row.id);
        this.captionLoads.delete(row.id);
        this.metas.delete(row.id);
      }
    }
  }
  private revisions = new Map<string, number>();
  list(): JobState[] {
    this.refresh();
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string) {
    this.refresh();
    return this.jobs.get(id);
  }

  async getWords(job: JobState): Promise<Word[]> {
    let w = this.words.get(job.id);
    if (!w) {
      w = JSON.parse(
        await readFile(path.join(workRoot(), job.dir, "words.json"), "utf8"),
      );
      this.words.set(job.id, w!);
    }
    return w!;
  }

  /** English caption words (words.en.json); [] when nothing is translated. */
  async getCaptionWords(job: JobState): Promise<Word[]> {
    const cached = this.captionWords.get(job.id);
    if (cached) return cached;
    // one disk read per job, shared by concurrent callers; a merge that lands meanwhile is never overwritten
    let load = this.captionLoads.get(job.id);
    if (!load) {
      load = readFile(path.join(workRoot(), job.dir, "words.en.json"), "utf8")
        .catch(() => "[]")
        .then((raw) => {
          if (!this.captionWords.has(job.id))
            this.captionWords.set(job.id, JSON.parse(raw) as Word[]);
        });
      this.captionLoads.set(job.id, load);
    }
    await load;
    return this.captionWords.get(job.id) ?? [];
  }

  /** The words to burn in for this clip: English (translating what's missing first) when the job needs it. */
  async captionWordsFor(job: JobState, c: ClipState): Promise<Word[]> {
    if (!this.needsTranslation(job)) return this.getWords(job);
    const range = { start: c.start, end: c.end };
    if (!covers(job.translated ?? [], range)) await this.translateFor(job, c);
    // a failed translation keeps the original captions (the card says so) rather than half-English ones
    return covers(job.translated ?? [], range)
      ? this.getCaptionWords(job)
      : this.getWords(job);
  }

  private async getMeta(job: JobState): Promise<VideoMeta> {
    let m = this.metas.get(job.id);
    if (!m) {
      m = JSON.parse(
        await readFile(path.join(workRoot(), job.dir, "meta.json"), "utf8"),
      ) as VideoMeta;
      this.metas.set(job.id, m);
    }
    return m;
  }

  private save(job: JobState) {
    const store = runtimeStore();
    fence(() => {
      const expected =
        currentWork()?.jobRevisions?.get(job.id) ??
        this.revisions.get(job.id) ??
        store.get("legacy-jobs", job.id)?.revision ??
        0;
      // A concurrent edit invalidates the worker's snapshot before it can publish files or queue a render.
      const row = store.get("legacy-jobs", job.id);
      if (currentWork() && row && row.revision !== expected)
        throw Object.assign(new Error("Job changed during worker execution"), {
          retryable: false,
          status: 409,
        });
      if (currentWork()) promoteJobFiles(job);
      const snapshot = JSON.parse(JSON.stringify(job), (_key, value) =>
        typeof value === "string" ? canonicalPath(value) : value,
      ) as JobState;
      const saved = store.save(
        "legacy-jobs",
        job.id,
        snapshot,
        row?.revision ?? 0,
      );
      this.revisions.set(job.id, saved.revision);
      currentWork()?.jobRevisions?.set(job.id, saved.revision);
      const ctx = currentWork();
      if (ctx?.lease.kind === "media")
        ctx.queue.checkpoint(ctx.lease, job.stage, {
          jobRevision: saved.revision,
          inputFingerprint: jobInputFingerprint(snapshot),
        });
    });
  }

  private async enqueue(job: JobState, operation: string, args: unknown[]) {
    await this.save(job);
    const revision = runtimeStore().get("legacy-jobs", job.id)!.revision;
    return enqueueWork({
      kind: "media",
      workKey: `${job.id}:${operation}:${JSON.stringify(args)}`,
      inputRevision: revision,
      payload: {
        jobId: job.id,
        operation,
        args,
        inputFingerprint: jobInputFingerprint(job),
      },
    });
  }

  async recoverDurable() {
    await this.init();
    for (const job of this.list()) {
      if (
        workQueue()
          .list()
          .some((task) => task.payload.jobId === job.id)
      )
        continue;
      if (["queued", "analyzing", "preparing"].includes(job.status))
        await this.enqueue(job, "analyze", [false]);
      const targets = job.clips.filter((c) =>
        ["queued", "rendering"].includes(c.render.status),
      );
      if (targets.length)
        await this.enqueue(
          job,
          "render",
          targets.map((c) => c.n),
        );
    }
  }
  workerFailure(lease: JobLease, error: unknown) {
    const job = this.jobs.get(String(lease.payload.jobId));
    if (!job) return;
    this.stopTicker(job);
    const message = error instanceof Error ? error.message : String(error);
    job.error = message;
    if (["analyzing", "preparing", "queued"].includes(job.status))
      job.status = job.clips.length ? "ready" : "error";
    for (const c of job.clips)
      if (c.render.status === "rendering")
        c.render = { status: "error", error: message };
    try {
      this.save(job);
    } catch {
      /* Ownership loss or a user edit must never be overwritten. */
    }
  }
  /** Runs only in the separate worker, under its generation workspace and fenced lease. */
  async executeWork(lease: JobLease) {
    await this.init();
    const id = String(lease.payload.jobId);
    const row = runtimeStore().get<JobState>("legacy-jobs", id);
    if (!row)
      throw Object.assign(new Error("Job missing"), { retryable: false });
    const prior = workQueue().get(lease.id)!;
    const fingerprint =
      prior.checkpoint.inputFingerprint ?? lease.payload.inputFingerprint;
    if (fingerprint && fingerprint !== jobInputFingerprint(row.value))
      throw Object.assign(Error("Job changed before worker execution"), {
        retryable: false,
        status: 409,
      });
    const job = structuredClone(row.value);
    this.jobs.set(id, job);
    this.revisions.set(id, row.revision);
    const ctx = currentWork()!;
    ctx.jobRevisions ??= new Map();
    ctx.jobRevisions.set(id, row.revision);
    this.words.delete(id);
    this.captionWords.delete(id);
    this.captionLoads.delete(id);
    this.metas.delete(id);
    const src = path.join(OUTPUT_ROOT, job.dir),
      dest = path.join(workRoot(), job.dir);
    if (existsSync(src))
      cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
    try {
      const op = String(lease.payload.operation);
      const args = (lease.payload.args ?? []) as unknown[];
      if (op === "analyze") await this.analyze(job, { repick: !!args[0] });
      else if (op === "render")
        for (const n of args as number[]) {
          const c = job.clips.find((x) => x.n === n);
          if (c && c.render.status !== "done") {
            c.render = { status: "queued" };
            await this.renderOne(job, c);
          }
        }
      else if (op === "segments") await this.prepareSegments(job);
      else if (op === "segment") {
        const c = job.clips.find((x) => x.n === Number(args[0]));
        if (c) await this.refetchSegment(job, c);
      } else {
        const method = this[op as keyof JobManager];
        if (typeof method !== "function")
          throw Object.assign(Error("Unsupported media operation"), {
            retryable: false,
          });
        const result = await (method as (...args: unknown[]) => unknown).call(
          this,
          id,
          ...args,
        );
        currentWork()!.queue.checkpoint(lease, op, { result });
      }
      return job;
    } finally {
      this.stopTicker(job);
    }
  }

  /** The AI chosen in Settings (Claude by default) and the model to ask it for. */
  private async ai(job: JobState) {
    const app = effective(); // default → env → settings.json
    const agent = app.agent;
    // the per-video model only applies to Claude; other agents use their Settings model or their own default
    const model =
      agent === "claude"
        ? (job.settings.model ?? app.model)
        : app.models[agent];
    return { agent, model };
  }

  private emitJob(job: JobState) {
    const ctx = currentWork();
    if (ctx) ctx.queue.assert(ctx.lease);
    this.emit(`job:${job.id}`, job);
    this.emit("jobs");
  }

  private async update(job: JobState, patch: Partial<JobState> = {}) {
    Object.assign(job, patch);
    this.emitJob(job);
    await this.save(job);
  }

  private log(
    job: JobState,
    stage: JobState["log"][number]["stage"],
    msg: string,
  ) {
    job.log.push({ t: Date.now(), stage, msg });
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    this.emitJob(job);
  }

  // ---------- estimates ----------

  private async recomputeEstimate(job: JobState) {
    const t = await loadTimings();
    const mins = (job.duration ?? 20 * 60) / 60;
    const kwords = (job.wordCount ?? mins * 150) / 1000;
    const stageCost: Record<Stage, number> = {
      meta: t.metaSec,
      captions:
        job.transcriptSource === "whisper"
          ? mins * t.whisperSecPerMin
          : t.captionsFlatSec + mins * t.captionsSecPerMin,
      pick: t.pickFlatSec + kwords * t.pickSecPerKWords,
      segments: this.segmentsCost(job, t),
      done: 0,
    };
    const order: Stage[] = ["meta", "captions", "pick", "segments", "done"];
    const idx = order.indexOf(job.stage);
    const elapsed = (Date.now() - job.stageStartedAt) / 1000;
    const stageRemaining =
      job.stage === "done" ? 0 : Math.max(2, stageCost[job.stage] - elapsed);
    let totalRemaining = stageRemaining;
    let total = 0;
    let doneCost = 0;
    order.forEach((s, i) => {
      total += stageCost[s];
      if (i < idx) doneCost += stageCost[s];
      if (i > idx) totalRemaining += stageCost[s];
    });
    const progress =
      job.stage === "done"
        ? 1
        : Math.min(
            0.98,
            (doneCost + Math.min(stageCost[job.stage], elapsed)) /
              Math.max(1, total),
          );
    job.estimate = {
      stageRemaining: Math.round(stageRemaining),
      totalRemaining: Math.round(totalRemaining),
      progress,
    };
  }

  private segmentsCost(job: JobState, t: Timings) {
    const pending = job.clips.filter(
      (c) => !c.segment || c.segment.status !== "done",
    );
    const secs = pending.reduce(
      (n, c) =>
        n +
        (segmentFor(c, job.duration ?? 0).end -
          segmentFor(c, job.duration ?? 0).start),
      0,
    );
    // two downloads run in parallel
    return (secs * t.segmentSecPerSec) / 2;
  }

  private async setStage(job: JobState, stage: Stage) {
    throwIfCancelled();
    job.stage = stage;
    job.stageStartedAt = Date.now();
    await this.recomputeEstimate(job);
    await this.update(job);
  }

  /** Tick estimates every second while a job is running so the countdown moves. */
  private tickers = new Map<string, NodeJS.Timeout>();
  private startTicker(job: JobState) {
    this.stopTicker(job);
    this.tickers.set(
      job.id,
      setInterval(() => {
        void (async () => {
          assertWork();
          await this.recomputeEstimate(job);
          for (const c of job.clips) {
            if (c.render.status === "rendering" && c.render.startedAt) {
              const t = await loadTimings();
              const est = (c.end - c.start) * t.renderSecPerSec;
              c.render.remaining = Math.max(
                1,
                Math.round(est - (Date.now() - c.render.startedAt) / 1000),
              );
            }
          }
          this.emitJob(job);
        })().catch(() => this.stopTicker(job));
      }, 1000),
    );
  }
  private stopTicker(job: JobState) {
    const t = this.tickers.get(job.id);
    if (t) clearInterval(t);
    this.tickers.delete(job.id);
  }

  // ---------- create / analyze ----------

  async create(
    url: string,
    settingsIn: Partial<JobSettings> = {},
    extra: { automation?: JobState["automation"] } = {},
  ): Promise<JobState> {
    await this.init();
    const videoId = videoIdFromUrl(url.trim());
    if (!videoId) throw new Error("That doesn't look like a YouTube link.");
    const existing = [...this.jobs.values()].find((j) => j.videoId === videoId);
    const settings: JobSettings = {
      ...DEFAULT_SETTINGS,
      ...(existing?.settings ?? {}),
      ...settingsIn,
    };
    settings.audience ??= effective().audience;
    if (existing) {
      if (extra.automation) {
        // automation reached a video that is already here: keep the user's settings and picks, render only what isn't
        existing.automation = extra.automation;
        if (existing.status === "analyzing" || existing.status === "preparing")
          return existing; // onReady runs when it's done
        if (existing.clips.length) {
          await this.update(existing);
          await this.onReady(existing);
          return existing;
        }
      }
      if (existing.status === "analyzing" || existing.status === "preparing")
        return existing;
      existing.settings = settings;
      if (existing.status === "error" || existing.clips.length === 0) {
        await this.enqueue(existing, "analyze", [true]);
      }
      return existing;
    }
    const job: JobState = {
      id: videoId,
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      status: "queued",
      stage: "meta",
      stageStartedAt: Date.now(),
      createdAt: Date.now(),
      settings,
      estimate: { stageRemaining: 0, totalRemaining: 0, progress: 0 },
      clips: [],
      log: [],
      dir: videoId, // replaced with the slug folder once we know the title
      ...(extra.automation ? { automation: extra.automation } : {}),
    };
    this.jobs.set(job.id, job);
    await this.enqueue(job, "analyze", [false]);
    return job;
  }

  async repick(id: string, settingsIn: Partial<JobSettings> = {}) {
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    if (job.status === "analyzing" || job.status === "preparing") return job;
    job.settings = { ...job.settings, ...settingsIn };
    await this.enqueue(job, "analyze", [true]);
    return job;
  }

  private yt(job: JobState) {
    return {
      cookiesFromBrowser: job.settings.browser ?? effective().browser,
      proxy: process.env.YT_PROXY,
    };
  }

  /** Stop the running analyze for this job. Picks from before a re-pick stay; footage not yet downloaded is marked. */
  async cancel(id: string) {
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    for (const task of workQueue()
      .list()
      .filter(
        (x) =>
          x.payload.jobId === id &&
          !["complete", "cancelled"].includes(x.status),
      ))
      await workQueue().cancel(task.id);
    this.log(job, job.stage, "Cancelled");
    job.status = job.clips.length ? "ready" : "error";
    job.error = job.clips.length ? undefined : "Cancelled";
    for (const c of job.clips) {
      if (["queued", "rendering"].includes(c.render.status))
        c.render = { status: "error", error: "Cancelled" };
      if (c.segment && c.segment.status !== "done")
        c.segment = { ...c.segment, status: "error", error: "Cancelled" };
    }
    await this.update(job);
    return job;
  }

  private stageComplete(stage: string) {
    return (
      (currentWork()?.queue.get(currentWork()!.lease.id)?.checkpoint
        .mediaComplete ?? []) as string[]
    ).includes(stage);
  }
  private completeStage(job: JobState, stage: string) {
    fence(() => {
      this.save(job);
      const ctx = currentWork();
      if (ctx) {
        const complete = (ctx.queue.get(ctx.lease.id)!.checkpoint
          .mediaComplete ?? []) as string[];
        ctx.queue.checkpoint(ctx.lease, stage, {
          mediaComplete: [...new Set([...complete, stage])],
        });
      }
    });
  }
  private async analyze(job: JobState, o: { repick: boolean }) {
    job.status = "analyzing";
    job.error = undefined;
    job.startedAt = Date.now();
    job.tookMs = undefined;
    this.startTicker(job);
    try {
      let meta: VideoMeta;
      let jobDir: string;
      if (this.stageComplete("meta")) {
        meta = await this.getMeta(job);
        jobDir = path.join(workRoot(), job.dir);
      } else {
        // 1. meta
        await this.setStage(job, "meta");
        const t0 = Date.now();
        const result = await stageMeta(job.url, workRoot(), this.yt(job));
        const { cached } = result;
        meta = result.meta;
        jobDir = result.jobDir;
        if (!cached) await learn("metaSec", (Date.now() - t0) / 1000);
        job.dir = path.relative(workRoot(), jobDir);
        job.title = meta.title;
        job.channel = meta.channel;
        job.duration = meta.duration;
        job.language = meta.language;
        this.metas.set(job.id, meta);
        this.log(
          job,
          "meta",
          `${meta.title} · ${Math.round(meta.duration / 60)} min${cached ? " (cached)" : ""}`,
        );

        this.completeStage(job, "meta");
      }
      let words: Word[];
      if (this.stageComplete("captions")) {
        words = await this.getWords(job);
      } else {
        // 2. words
        await this.setStage(job, "captions");
        const t1 = Date.now();
        const result = await stageWords(job.url, jobDir, meta, this.yt(job), {
          lang: job.settings.lang,
          log: (m) => this.log(job, "captions", m),
        });
        const { source } = result;
        words = result.words;
        this.words.set(job.id, words);
        job.wordCount = words.length;
        job.sourceLang =
          meta.language ?? pickCaptionLang(meta, job.settings.lang)?.lang;
        job.transcriptSource = source;
        const took = (Date.now() - t1) / 1000;
        if (source === "captions") {
          await learn(
            "captionsFlatSec",
            Math.max(1, took - (meta.duration / 60) * 0.4),
          );
        } else if (source === "whisper") {
          await learn(
            "whisperSecPerMin",
            took / Math.max(1, meta.duration / 60),
          );
        }
        this.log(
          job,
          "captions",
          `${words.length} words from ${source === "cache" ? "cached transcript" : source === "captions" ? "YouTube captions" : "local Whisper"}`,
        );

        this.completeStage(job, "captions");
      }
      // 3. pick (skip if we already have clips and weren't asked to repick)
      await this.setStage(job, "pick");
      if (!this.stageComplete("pick") && (o.repick || job.clips.length === 0)) {
        const { agent, model } = await this.ai(job);
        this.log(
          job,
          "pick",
          `asking ${agentSpec(agent).name}${model ? ` (${model})` : ""} for ${job.settings.count} clips (${job.settings.minSec}-${job.settings.maxSec}s) plus 2 spares for the reviewer`,
        );
        const t2 = Date.now();
        const peaks = replayPeaks(meta.heatmap);
        if (peaks.length)
          this.log(
            job,
            "pick",
            `${peaks.length} "Most replayed" peaks sent to the picker`,
          );
        const res = await stagePick(words, meta, {
          // two extra candidates so the reviewer can flag weak ones and still leave `count`
          count: job.settings.count + 2,
          peaks,
          audience: job.settings.audience,
          minSec: job.settings.minSec,
          maxSec: job.settings.maxSec,
          agent,
          model,
          focus: job.settings.focus,
          onRetry: (m) => this.log(job, "pick", m),
        });
        await learn(
          "pickSecPerKWords",
          Math.max(
            0.2,
            ((Date.now() - t2) / 1000 - 6) / Math.max(0.5, words.length / 1000),
          ),
        );
        job.pickCostUsd = res.costUsd;
        job.clips = res.clips.map((c, i) => ({
          ...c,
          n: i + 1,
          selected: true,
          render: { status: "none" },
          publish: c.ytTitle
            ? {
                ytTitle: c.ytTitle,
                description: c.description ?? "",
                hashtags: c.hashtags ?? [],
              }
            : undefined,
          replayPeak: peakFor(peaks, c.start, c.end),
        }));
        try {
          const items = await reviewPicks(
            words,
            { title: meta.title, channel: meta.channel },
            job.clips,
            { audience: job.settings.audience, agent, model },
          );
          job.clips = applyReview(job.clips, items, job.settings.count);
          const fails = job.clips.filter(
            (c) => c.review?.verdict === "fail",
          ).length;
          const fixed = job.clips.filter(
            (c) => c.review?.verdict === "fix_hook",
          ).length;
          const unreviewed = job.clips.filter(
            (c) => c.review?.verdict === "needs_review",
          ).length;
          this.log(
            job,
            "pick",
            `reviewer: ${job.clips.length - fails - fixed - unreviewed} passed, ${fixed} hook${fixed === 1 ? "" : "s"} rewritten, ${fails} flagged`,
          );
        } catch (e) {
          if (isCancelled(e)) throw e;
          // Missing review leaves drafts available for explicit human review.
          job.clips = applyReview(job.clips, [], job.settings.count);
          this.log(
            job,
            "pick",
            `review skipped: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        await writeFile(
          path.join(jobDir, "clips.json"),
          JSON.stringify(
            { video: job.url, agent, model, clips: res.clips, raw: res.raw },
            null,
            2,
          ),
        );
        this.log(
          job,
          "pick",
          `${job.clips.length} clips picked in ${((Date.now() - t2) / 1000).toFixed(1)}s`,
        );
      }

      this.completeStage(job, "pick");
      // 4. segments + thumbnails
      job.status = "preparing";
      await this.setStage(job, "segments");
      if (!this.stageComplete("segments")) await this.prepareSegments(job);
      this.completeStage(job, "segments");

      await this.setStage(job, "done");
      job.status = "ready";
      job.tookMs = Date.now() - job.startedAt!;
      this.log(
        job,
        "done",
        `ready in ${fmtDur(job.tookMs)} — ${job.clips.length} picks, footage downloaded`,
      );
      await this.update(job);
      await this.onReady(job);
    } catch (e) {
      if (currentWork()) throw e;
      if (isCancelled(e)) {
        // footage that never finished is marked so the clip page says so instead of spinning forever
        for (const c of job.clips)
          if (c.segment && c.segment.status !== "done")
            c.segment = { ...c.segment, status: "error", error: "Cancelled" };
        job.status = job.clips.length ? "ready" : "error";
        job.error = job.clips.length ? undefined : "Cancelled";
        this.log(job, "error", `cancelled during ${job.stage}`);
        if (job.automation) this.finishAutomation(job, "error", "Cancelled");
      } else {
        job.status = "error";
        job.error = e instanceof Error ? e.message : String(e);
        this.log(job, "error", job.error);
        if (job.automation) this.finishAutomation(job, "error", job.error);
      }
      await this.update(job);
    } finally {
      this.stopTicker(job);
    }
  }

  /** Download padded segments for clips that don't have one yet (2 at a time). */
  private async prepareSegments(job: JobState) {
    if (job.clips.every((c) => this.segmentCovers(c))) return;
    const jobDir = path.join(workRoot(), job.dir);
    const todo = job.clips.filter(
      (c) =>
        !c.segment || c.segment.status !== "done" || !this.segmentCovers(c),
    );
    for (const c of todo)
      c.segment = {
        ...segmentFor(c, job.duration ?? 0),
        url: "",
        status: "queued",
      };
    this.emitJob(job);
    const results = await pool(todo, 1, async (c) => {
      c.segment!.status = "downloading";
      this.log(
        job,
        "segments",
        `downloading ${fmt(c.start)}–${fmt(c.end)} (+${15}s padding)`,
      );
      const t0 = Date.now();
      try {
        const seg = await stageSegment(
          job.url,
          jobDir,
          c.n,
          c,
          job.duration ?? 0,
          this.yt(job),
          job.settings.maxRes,
        );
        c.segment = {
          start: seg.start,
          end: seg.end,
          url: workMediaUrl(seg.file),
          status: "done",
        };
        c.thumbUrl = workMediaUrl(seg.thumb) + `?v=${Date.now()}`;
        await learn(
          "segmentSecPerSec",
          (Date.now() - t0) / 1000 / Math.max(1, seg.end - seg.start),
        );
        await this.translateFor(job, c);
      } catch (e) {
        if (isCancelled(e)) throw new CancelledError();
        if (currentWork()) throw e;
        c.segment = {
          ...c.segment!,
          status: "error",
          error: e instanceof Error ? e.message.split("\n").pop() : String(e),
        };
        this.log(
          job,
          "segments",
          `clip ${c.n} download failed: ${c.segment.error}`,
        );
      }
      await this.recomputeEstimate(job);
      await this.update(job);
    });
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  }

  private segmentCovers(c: ClipState) {
    return (
      !!c.segment &&
      c.segment.status === "done" &&
      c.start >= c.segment.start - 0.01 &&
      c.end <= c.segment.end + 0.01
    );
  }

  // ---------- editing ----------

  async updateClip(
    id: string,
    n: number,
    patch: Partial<
      Pick<
        ClipState,
        | "start"
        | "end"
        | "title"
        | "hook"
        | "reason"
        | "score"
        | "selected"
        | "publish"
      >
    > & { snap?: boolean },
  ) {
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    const c = job.clips.find((x) => x.n === n);
    if (!c) throw new Error("No such clip");
    const before = { start: c.start, end: c.end, title: c.title, hook: c.hook };
    if (patch.snap && (patch.start !== undefined || patch.end !== undefined)) {
      const words = await this.getWords(job);
      const s = snapToWords(
        words,
        patch.start ?? c.start,
        patch.end ?? c.end,
        1.0,
      );
      patch.start = s.start;
      patch.end = s.end;
    }
    const { snap: _s, ...rest } = patch;
    const prevTags = c.publish?.tags;
    Object.assign(c, rest);
    if (patch.publish && c.publish) {
      // the user's own words: SEO keeps scoring them but never rewrites them (search tags carry over)
      c.publish = {
        ...(prevTags && !c.publish.tags ? { tags: prevTags } : {}),
        ...c.publish,
        edited: true,
      };
      const p = c.publish;
      c.seo = {
        ...scoreSeo(
          {
            title: p.ytTitle,
            description: p.description,
            hashtags: p.hashtags,
            tags: p.tags ?? [],
          },
          { kind: "short", keyword: c.seo?.keyword },
        ),
        at: Date.now(),
        note: "Your own text: capy scores it but won't rewrite it.",
      };
    }
    const rendered = renderFile(c);
    if (patch.publish && rendered) {
      // keep the .txt next to the mp4 in sync without re-rendering
      if (currentWork())
        await writePublishFiles(rendered, { ...c, ...c.publish });
      else await this.enqueue(job, "generatePublishFiles", [c.n]);
    }
    if (c.end - c.start < 3) c.end = c.start + 3;
    const timingChanged = before.start !== c.start || before.end !== c.end;
    const textChanged = before.title !== c.title || before.hook !== c.hook;
    if ((timingChanged || textChanged) && c.render.status === "done")
      c.render.status = "stale";
    if (timingChanged) {
      // the candidate frames were taken from the old range
      c.thumbs = undefined;
      c.thumbAt = undefined;
    }
    if (timingChanged && !this.segmentCovers(c)) {
      // edit went outside the padded segment: fetch a new one in the background
      c.render = { status: "none" };
      c.captionsTranslated = undefined;
      if (currentWork()) await this.refetchSegment(job, c);
      else await this.enqueue(job, "segment", [c.n]);
    }
    await this.update(job);
    return c;
  }

  /**
   * Change how every clip of this video renders (look, caption style, layout, captions/hook on-off).
   * Finished renders are marked stale so the cards offer a re-render; nothing is re-rendered here.
   */
  async updateSettings(
    id: string,
    patch: Partial<
      Pick<JobSettings, "look" | "style" | "layout" | "captions" | "hook">
    >,
  ) {
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    if (job.status === "analyzing" || job.status === "preparing")
      throw new Error("Wait for the picks to finish");
    const style = patch.style ?? job.settings.style;
    const next: JobSettings = { ...job.settings, style };
    if (patch.layout !== undefined) next.layout = patch.layout;
    if (patch.captions !== undefined) next.captions = patch.captions;
    if (patch.hook !== undefined) next.hook = patch.hook;
    if (patch.look !== undefined) next.look = normalizeLook(patch.look, style);
    const changed: string[] = [];
    if (next.style !== job.settings.style) changed.push("style");
    if (next.layout !== job.settings.layout) changed.push("layout");
    if (next.captions !== job.settings.captions) changed.push("captions");
    if (next.hook !== job.settings.hook) changed.push("hook");
    if (
      !looksEqual(
        normalizeLook(next.look, next.style),
        normalizeLook(job.settings.look, job.settings.style),
      )
    )
      changed.push("look");
    job.settings = next;
    if (changed.length) {
      let stale = 0;
      for (const c of job.clips) {
        if (c.render.status === "done") {
          c.render.status = "stale";
          stale++;
        }
      }
      this.log(
        job,
        "render",
        `${changed.join(", ")} changed · ${stale} clip${stale === 1 ? "" : "s"} need a re-render`,
      );
    }
    await this.update(job);
    return job;
  }

  async addClip(id: string, start: number, end: number) {
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    const n = Math.max(0, ...job.clips.map((c) => c.n)) + 1;
    const c: ClipState = {
      n,
      start,
      end,
      title: `Clip ${n}`,
      hook: "",
      reason: "Added manually",
      score: 5,
      selected: true,
      render: { status: "none" },
    };
    job.clips.push(c);
    await this.update(job);
    if (currentWork()) await this.refetchSegment(job, c);
    else await this.enqueue(job, "segment", [c.n]);
    return c;
  }

  async removeClip(id: string, n: number) {
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    job.clips = job.clips.filter((c) => c.n !== n);
    await this.update(job);
  }

  private async refetchSegment(job: JobState, c: ClipState) {
    const jobDir = path.join(workRoot(), job.dir);
    c.segment = {
      ...segmentFor(c, job.duration ?? 0),
      url: "",
      status: "downloading",
    };
    this.emitJob(job);
    try {
      const seg = await stageSegment(
        job.url,
        jobDir,
        c.n,
        c,
        job.duration ?? 0,
        this.yt(job),
        job.settings.maxRes,
      );
      c.segment = {
        start: seg.start,
        end: seg.end,
        url: workMediaUrl(seg.file),
        status: "done",
      };
      c.thumbUrl = workMediaUrl(seg.thumb) + `?v=${Date.now()}`;
      await this.update(job);
      await this.translateFor(job, c);
    } catch (e) {
      if (currentWork()) throw e;
      c.segment = {
        ...c.segment!,
        status: "error",
        error: e instanceof Error ? e.message.split("\n").pop() : String(e),
      };
    }
    await this.update(job);
  }

  private needsTranslation(job: JobState) {
    return job.settings.audience === "en-us" && !isEnglish(job.sourceLang);
  }

  /**
   * Translate what isn't translated yet of the clip's padded segment (or the clip itself when it reaches past the
   * segment) into <jobDir>/words.en.json. Whole transcript phrases only, so neighbouring clips share lines.
   */
  private async translateFor(job: JobState, c: ClipState) {
    if (!this.needsTranslation(job)) return;
    const seg = c.segment?.status === "done" ? c.segment : undefined;
    const range = {
      start: Math.min(seg?.start ?? c.start, c.start),
      end: Math.max(seg?.end ?? c.end, c.end),
    };
    if (covers(job.translated ?? [], range)) {
      c.captionsTranslated = true;
      return;
    }
    const { agent, model } = await this.ai(job);
    try {
      const { todo, nextStart } = phrasesToTranslate(
        await this.getWords(job),
        range,
        job.translated ?? [],
      );
      const add = await translatePhrases(todo, nextStart, job.sourceLang, {
        agent,
        model,
      });
      const spans = todo.map((p) => ({ start: p.start, end: p.end }));
      // merge into the in-memory copy with no await in between, then queue the file write
      await this.getCaptionWords(job); // loaded once; read the live copy below, not a snapshot from before an await
      const merged = mergeWords(
        this.captionWords.get(job.id) ?? [],
        add,
        spans,
      );
      this.captionWords.set(job.id, merged);
      job.translated = coalesce([...(job.translated ?? []), range, ...spans]);
      const file = path.join(workRoot(), job.dir, "words.en.json");
      this.enWrites = this.enWrites
        .then(() =>
          writeFile(file, JSON.stringify(this.captionWords.get(job.id) ?? [])),
        )
        .catch(() => {});
      await this.enWrites;
      c.captionsTranslated = true;
      this.log(job, "segments", `clip ${c.n} captions translated to English`);
    } catch (e) {
      if (isCancelled(e)) throw e;
      c.captionsTranslated = "error";
      this.log(
        job,
        "segments",
        `clip ${c.n} captions not translated: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Retry the caption translation for one clip. */
  async translateClip(id: string, n: number) {
    if (!currentWork()) return this.requestOperation(id, "translateClip", [n]);
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    const c = job.clips.find((x) => x.n === n);
    if (!c) throw new Error("No such clip");
    if (c.segment?.status !== "done")
      throw new Error("Footage is still downloading. Try again in a moment.");
    await this.translateFor(job, c);
    await this.update(job);
    return c;
  }

  /** Replace only works on a pick with no render (none, or a failed one) while the job isn't re-picking. */
  private assertReplaceable(job: JobState, n: number) {
    const c = job.clips.find((x) => x.n === n);
    const no = (msg: string) => Object.assign(new Error(msg), { status: 409 });
    if (!c) throw no("This clip was removed.");
    if (job.status === "analyzing" || job.status === "preparing")
      throw no("Wait for the picks to finish");
    if (c.render.status !== "none" && c.render.status !== "error")
      throw no("This clip is rendered or queued to render. Remove it instead.");
  }

  /** Swap one pick for a new moment, steering the picker away from `reason`. */
  async replaceClip(id: string, n: number, reason?: string) {
    if (!currentWork())
      return this.requestOperation(id, "replaceClip", [n, reason]);
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    const c = job.clips.find((x) => x.n === n);
    if (!c) throw new Error("No such clip");
    this.assertReplaceable(job, n);
    const words = await this.getWords(job);
    const meta = await this.getMeta(job);
    const { agent, model } = await this.ai(job);
    const why =
      reason?.trim() ||
      c.review?.problem ||
      "the editor wants a different moment";
    const peaks = replayPeaks(meta.heatmap);
    this.log(job, "pick", `replacing clip ${n}: ${why}`);
    const res = await pickClips(words, meta, {
      count: 1,
      minSec: job.settings.minSec,
      maxSec: job.settings.maxSec,
      agent,
      model,
      focus: job.settings.focus,
      audience: job.settings.audience,
      peaks,
      replace: {
        start: c.start,
        end: c.end,
        reason: why,
        avoid: job.clips
          .filter((x) => x.n !== n)
          .map((x) => ({ start: x.start, end: x.end })),
      },
    });
    const fresh = res.clips.find(
      (x) => !job.clips.some((t) => x.start < t.end - 1 && x.end > t.start + 1),
    );
    if (!fresh)
      throw new Error(
        "No other good moment found. Try a different reason or a longer max length.",
      );
    let next: ClipState = {
      ...fresh,
      n,
      selected: true,
      render: { status: "none" },
      publish: fresh.ytTitle
        ? {
            ytTitle: fresh.ytTitle,
            description: fresh.description ?? "",
            hashtags: fresh.hashtags ?? [],
          }
        : undefined,
      replayPeak: peakFor(peaks, fresh.start, fresh.end),
    };
    try {
      const items = await reviewPicks(
        words,
        { title: meta.title, channel: meta.channel },
        [next],
        { audience: job.settings.audience, agent, model },
      );
      next = applyReview([next], items, 1)[0]!;
    } catch (e) {
      next = applyReview([next], [], 1)[0]!;
      this.log(
        job,
        "pick",
        `review unavailable; needs review: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // the AI took a while: the clip may have been queued to render, removed, or re-picked meanwhile
    this.assertReplaceable(job, n);
    job.clips = job.clips.map((x) => (x.n === n ? next : x));
    this.log(job, "pick", `clip ${n} replaced: ${next.title}`);
    await this.update(job);
    if (currentWork()) await this.refetchSegment(job, next);
    else await this.enqueue(job, "segment", [next.n]);
    return next;
  }

  /** Ask Claude for YouTube title/description/hashtags for one clip (fills in old picks, or regenerates). */
  async generatePublish(id: string, n: number) {
    if (!currentWork())
      return this.requestOperation(id, "generatePublish", [n]);
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    const c = job.clips.find((x) => x.n === n);
    if (!c) throw new Error("No such clip");
    const words = await this.getWords(job);
    const { agent, model } = await this.ai(job);
    c.publish = await generatePublish(
      words,
      { title: job.title ?? "", channel: job.channel },
      c,
      model,
      agent,
      job.settings.audience,
    );
    const rendered = renderFile(c);
    if (rendered) {
      const { thumb, text } = await writePublishFiles(rendered, {
        ...c,
        ...c.publish,
      });
      c.render.thumbUrl = workMediaUrl(thumb) + `?v=${Date.now()}`;
      c.render.textUrl = workMediaUrl(text);
    }
    await this.update(job);
    return c;
  }

  /** Grab candidate thumbnail frames: from the rendered clip when there is one, else from the source footage. */
  async generateThumbs(id: string, n: number) {
    if (!currentWork()) return this.requestOperation(id, "generateThumbs", [n]);
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    const c = job.clips.find((x) => x.n === n);
    if (!c) throw new Error("No such clip");
    const jobDir = path.join(workRoot(), job.dir);
    const rendered = renderFile(c);
    const src = rendered
      ? { file: rendered, offset: 0 }
      : c.segment?.status === "done"
        ? { file: segFile(jobDir, c, job), offset: c.start - c.segment.start }
        : null;
    if (!src)
      throw new Error("Footage is still downloading. Try again in a moment.");
    const files = await thumbCandidates(
      jobDir,
      c.n,
      c,
      src,
      job.settings.layout,
    );
    const v = Date.now();
    c.thumbs = files.map((f) => ({
      url: workMediaUrl(f.file) + `?v=${v}`,
      at: f.at,
    }));
    await this.update(job);
    return c;
  }

  /** Use the frame `at` seconds into the clip as its thumbnail. Rewrites NN-title.jpg when the clip is rendered. */
  async chooseThumb(id: string, n: number, at: number) {
    if (!currentWork())
      return this.requestOperation(id, "chooseThumb", [n, at]);
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    const c = job.clips.find((x) => x.n === n);
    if (!c) throw new Error("No such clip");
    if (!Number.isFinite(at) || at < 0) throw new Error("Bad frame time");
    c.thumbAt = at;
    const jobDir = path.join(workRoot(), job.dir);
    const rendered = renderFile(c);
    if (rendered) {
      const { thumb } = await writePublishFiles(rendered, {
        ...c,
        ytTitle: c.publish?.ytTitle,
        description: c.publish?.description,
        hashtags: c.publish?.hashtags,
      });
      c.render.thumbUrl = workMediaUrl(thumb) + `?v=${Date.now()}`;
    } else if (c.segment?.status === "done") {
      // not rendered yet: update the card picture; the real thumbnail is grabbed from the render later
      const file = path.join(
        jobDir,
        "work",
        `${String(c.n).padStart(2, "0")}.jpg`,
      );
      await thumbnail(
        segFile(jobDir, c, job),
        file,
        c.start - c.segment.start + at,
        job.settings.layout,
      );
      c.thumbUrl = workMediaUrl(file) + `?v=${Date.now()}`;
    }
    await this.update(job);
    return c;
  }

  /** Ask Claude for a title + hook that match the clip's reason. Returns a suggestion; nothing is saved. */
  async suggestTitleHook(id: string, n: number) {
    if (!currentWork())
      return this.requestOperation(id, "suggestTitleHook", [n]);
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    const c = job.clips.find((x) => x.n === n);
    if (!c) throw new Error("No such clip");
    const words = await this.getWords(job);
    const { agent, model } = await this.ai(job);
    return rewriteTitleHook(
      words,
      { title: job.title ?? "", channel: job.channel },
      c,
      model,
      agent,
      job.settings.audience,
    );
  }

  private async requestOperation(
    id: string,
    operation: string,
    args: unknown[],
  ): Promise<any> {
    await this.init();
    const job = this.get(id);
    if (!job) throw Error("No such job");
    const work = await this.enqueue(job, operation, args);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const task = workQueue().get(work.id)!;
      if (task.status === "complete") return task.checkpoint.result;
      if (["cancelled", "needs_action", "blocked"].includes(task.status))
        throw Object.assign(Error(task.error ?? task.status), {
          status:
            task.checkpoint.errorStatus ??
            (/changed during/.test(task.error ?? "") ? 409 : undefined),
        });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Error("Work queued; the worker is still processing it");
  }
  async generatePublishFiles(id: string, n: number) {
    const job = this.get(id);
    const c = job?.clips.find((x) => x.n === n);
    if (!job || !c) return;
    const rendered = renderFile(c);
    if (rendered) await writePublishFiles(rendered, { ...c, ...c.publish });
    await this.update(job);
    return c;
  }

  // ---------- rendering ----------

  async render(id: string, ns?: number[]) {
    const job = this.get(id);
    if (!job) throw new Error("No such job");
    const targets = job.clips.filter(
      (c) =>
        (ns ? ns.includes(c.n) : c.selected) && c.segment?.status === "done",
    );
    for (const c of targets)
      if (c.render.status !== "rendering") c.render = { status: "queued" };
    await this.update(job);
    if (targets.length)
      await this.enqueue(
        job,
        "render",
        targets.map((c) => c.n),
      );
    return job;
  }

  private async renderOne(job: JobState, c: ClipState) {
    if (c.render.status !== "queued") return;
    const jobDir = path.join(workRoot(), job.dir);
    const words = await this.captionWordsFor(job, c);
    const t = await loadTimings();
    const len = c.end - c.start;
    c.render = {
      status: "rendering",
      progress: 0,
      startedAt: Date.now(),
      remaining: Math.round(len * t.renderSecPerSec),
    };
    this.startTicker(job);
    this.log(job, "render", `rendering clip ${c.n}: ${c.title}`);
    try {
      const file = await stageRender(
        jobDir,
        c.n,
        {
          ...c,
          ytTitle: c.publish?.ytTitle,
          description: c.publish?.description,
          hashtags: c.publish?.hashtags,
        },
        {
          start: c.segment!.start,
          end: c.segment!.end,
          file: segFile(jobDir, c, job),
        },
        words,
        {
          layout: job.settings.layout,
          style: job.settings.style,
          captions: job.settings.captions,
          hook: job.settings.hook,
          look: normalizeLook(job.settings.look, job.settings.style),
          onProgress: (outSec) => {
            c.render.progress = Math.min(0.99, outSec / len);
            this.emitJob(job);
          },
        },
      );
      const tookMs = Date.now() - c.render.startedAt!;
      await learn("renderSecPerSec", tookMs / 1000 / len);
      const base = file.replace(/\.mp4$/, "");
      c.render = {
        status: "done",
        file: canonicalPath(file),
        url: workMediaUrl(file) + `?v=${Date.now()}`,
        thumbUrl: workMediaUrl(`${base}.jpg`) + `?v=${Date.now()}`,
        textUrl: workMediaUrl(`${base}.txt`),
        progress: 1,
        tookMs,
      };
      this.log(
        job,
        "render",
        `clip ${c.n} done in ${(tookMs / 1000).toFixed(1)}s`,
      );
      // the AI content reviewer looks at every clip that is about to be posted (and everything automation makes)
      const queueing =
        job.settings.autoPost !== false &&
        publicAccounts().some((a) => a.connected && a.autoPost);
      if (job.automation || queueing) {
        // search-tune the upload text first, so the content reviewer judges the text that will actually go out
        await this.tuneSeo(job, c, words, base).catch((e) =>
          this.log(
            job,
            "render",
            `clip ${c.n} SEO skipped: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
        c.contentReview = await this.contentReview(job, c, words).catch((e) =>
          reviewUnavailable(
            e instanceof Error ? e.message : String(e),
            Date.now(),
          ),
        );
        this.log(
          job,
          "render",
          `clip ${c.n} AI review: ${c.contentReview.verdict}${c.contentReview.summary ? ` (${c.contentReview.summary})` : ""}`,
        );
      }
      try {
        await this.save(job);
        fence(() => onRendered(job, c, toMediaUrl));
      } catch (e) {
        this.log(
          job,
          "render",
          `auto-post: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // candidate thumbnails from the finished clip, so the publish panel has options right away
      await this.generateThumbs(job.id, c.n).catch(() => {});
    } catch (e) {
      if (currentWork()) throw e;
      c.render = {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      };
      this.log(
        job,
        "render",
        `clip ${c.n} failed: ${c.render.error!.split("\n")[0]}`,
      );
    } finally {
      if (currentWork()) this.stopTicker(job);
      if (
        !job.clips.some((x) => x.render.status === "rendering") &&
        job.status === "ready"
      )
        this.stopTicker(job);
      // automation: once nothing of this job is waiting to render, record how it went
      if (
        job.automation &&
        !job.clips.some(
          (x) =>
            x.render.status === "queued" || x.render.status === "rendering",
        )
      ) {
        const done = job.clips.filter((x) => x.render.status === "done").length;
        this.finishAutomation(
          job,
          done ? "rendered" : "error",
          done ? undefined : "Every render failed",
        );
      }
      await this.update(job);
    }
  }

  // ---------- automation ----------

  /** The picks are ready: automation jobs render the ones the reviewer passed (the selected ones) not yet rendered. */
  async onReady(job: JobState) {
    if (!job.automation) return;
    const picked = job.clips.filter((c) => c.selected);
    if (!picked.length) {
      this.log(
        job,
        "render",
        "automation: no clip passed review, nothing to render",
      );
      return this.finishAutomation(job, "error", "No clip passed review");
    }
    const busy = (c: ClipState) =>
      c.render.status === "queued" || c.render.status === "rendering";
    const todo = picked.filter(
      (c) =>
        c.segment?.status === "done" && c.render.status !== "done" && !busy(c),
    );
    if (!todo.length) {
      if (picked.some(busy)) return; // renders under way finish the job's automation
      if (picked.some((c) => c.render.status === "done"))
        return this.finishAutomation(job, "rendered");
      return this.finishAutomation(
        job,
        "error",
        "The picked clips have no footage (download failed or was cancelled)",
      );
    }
    this.log(
      job,
      "render",
      `automation: rendering ${todo.length} clip${todo.length === 1 ? "" : "s"}`,
    );
    await this.render(
      job.id,
      todo.map((c) => c.n),
    );
  }

  /** After a restart: automation videos that were mid-way are picked up again (or recorded) instead of blocking the line. */
  async resumeAutomation() {
    const processing = new Set(
      watch()
        .get()
        .channels.flatMap((c) =>
          c.history
            .filter((h) => h.status === "processing")
            .map((h) => h.jobId),
        ),
    );
    for (const job of this.jobs.values()) {
      if (
        !job.automation ||
        !processing.has(job.id) ||
        job.status === "analyzing" ||
        job.status === "preparing"
      )
        continue;
      if (job.status === "ready" && job.clips.length) await this.onReady(job);
      else
        this.finishAutomation(
          job,
          "error",
          "Interrupted (capy was closed or the run was cancelled)",
        );
    }
  }

  /** Record how an automation video went, and stop treating the job as automation (later re-picks are the user's). */
  private finishAutomation(
    job: JobState,
    status: "rendered" | "error",
    error?: string,
  ) {
    const toQueue =
      job.settings.autoPost !== false &&
      publicAccounts().some((a) => a.connected && a.autoPost);
    const note =
      status === "rendered" && !toQueue
        ? "No posting account connected: the clips are on the video page, not in Queue"
        : undefined;
    try {
      fence(() =>
        watch().mutate((f) => markHistory(f, job.id, status, error, note)),
      );
    } catch (e) {
      this.log(
        job,
        "render",
        `automation history: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    job.automation = undefined;
    this.save(job);
  }

  /** Keyword research + an SEO rewrite of the clip's upload text (kept only if it scores higher). Never throws. */
  private async tuneSeo(
    job: JobState,
    c: ClipState,
    captionWords: Word[],
    base: string,
  ) {
    const publish = c.publish ?? {
      ytTitle: c.title,
      description: "",
      hashtags: [],
    };
    if (publish.edited) {
      c.seo = {
        ...scoreSeo(
          {
            title: publish.ytTitle,
            description: publish.description,
            hashtags: publish.hashtags,
            tags: publish.tags ?? [],
          },
          { kind: "short", keyword: c.seo?.keyword },
        ),
        at: Date.now(),
        note: "Your own text: capy scores it but won't rewrite it.",
      };
      return;
    }
    const about = [
      c.title,
      c.hook,
      cleanCaptionWords(wordsInRange(captionWords, c.start, c.end))
        .map((w) => w.text)
        .join(" "),
    ]
      .filter(Boolean)
      .join("\n");
    const keep = publish.description
      .split("\n")
      .find((l) => /^\s*credit:/i.test(l))
      ?.trim();
    const { publish: next, seo } = await tuneSeo(
      { kind: "short", publish, about, keep },
      await this.ai(job),
    );
    c.publish = next;
    c.seo = seo;
    this.log(
      job,
      "render",
      `clip ${c.n} SEO: ${seo.before !== undefined && seo.before !== seo.score ? `${seo.before} → ` : ""}${seo.score}${seo.keyword ? ` for "${seo.keyword}"` : ""}${seo.note ? ` (${seo.note})` : ""}`,
    );
    // the upload-text file next to the mp4 shows what will be posted
    const tags = next.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
    await writeFile(
      `${base}.txt`,
      [
        `TITLE`,
        next.ytTitle,
        ``,
        `DESCRIPTION`,
        next.description,
        ``,
        `HASHTAGS`,
        tags,
        ``,
        `TAGS`,
        (next.tags ?? []).join(", "),
        ``,
      ].join("\n"),
      "utf8",
    ).catch(() => {});
  }

  /** The AI content reviewer on a finished clip: what viewers read, what it's posted with, and the original words. */
  private async contentReview(
    job: JobState,
    c: ClipState,
    captionWords: Word[],
  ): Promise<ContentReview> {
    // the same cleanup the caption renderer applies, so the reviewer judges what viewers actually read
    const text = (ws: Word[]) =>
      cleanCaptionWords(wordsInRange(ws, c.start, c.end))
        .map((w) => w.text)
        .join(" ");
    const translated =
      c.captionsTranslated === true && this.needsTranslation(job);
    const { agent, model } = await this.ai(job);
    return reviewContent(
      {
        videoTitle: job.title ?? "",
        channel: job.channel,
        clipTitle: c.title,
        hook: c.hook,
        transcript: text(captionWords),
        original: translated ? text(await this.getWords(job)) : undefined,
        sourceLang: translated ? job.sourceLang : undefined,
        ytTitle: c.publish?.ytTitle,
        caption: c.publish?.description,
        hashtags: c.publish?.hashtags,
      },
      { agent, model },
    );
  }
}

function jobInputFingerprint(job: JobState) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        url: job.url,
        settings: job.settings,
        clips: job.clips.map((c) => ({
          n: c.n,
          start: c.start,
          end: c.end,
          title: c.title,
          hook: c.hook,
          selected: c.selected,
          publish: c.publish?.edited ? c.publish : undefined,
        })),
      }),
    )
    .digest("hex");
}
function workRoot() {
  return currentWork()?.workspace ?? OUTPUT_ROOT;
}
function canonicalPath(value: string) {
  const root = currentWork()?.workspace;
  if (!root) return value;
  return value
    .replaceAll(root, OUTPUT_ROOT)
    .replaceAll(toMediaUrl(root), toMediaUrl(OUTPUT_ROOT));
}
function workMediaUrl(abs: string) {
  return toMediaUrl(canonicalPath(abs));
}
/** Generation files are copied to temporary siblings, then renamed while SQLite holds the fence. */
function promoteJobFiles(job: JobState) {
  const root = currentWork()!.workspace;
  const base = path.join(root, job.dir);
  if (!existsSync(base)) return;
  const completed = new Set<string>();
  for (const c of job.clips) {
    if (c.segment?.status === "done")
      completed.add(path.basename(decodeURIComponent(c.segment.url)));
    if (c.render.status === "done" && c.render.file)
      completed.add(path.basename(c.render.file));
  }
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(from);
        continue;
      }
      if (
        entry.isSymbolicLink() ||
        /\.(part|tmp)$/.test(entry.name) ||
        entry.name === "job.json"
      )
        continue;
      if (entry.name.endsWith(".mp4") && !completed.has(entry.name)) continue;
      const to = path.join(OUTPUT_ROOT, path.relative(root, from));
      mkdirSync(path.dirname(to), { recursive: true });
      if (
        existsSync(to) &&
        statSync(to).size === statSync(from).size &&
        statSync(to).mtimeMs >= statSync(from).mtimeMs
      )
        continue;
      const tmp = `${to}.worker-${currentWork()!.lease.generation}.tmp`;
      copyFileSync(from, tmp);
      renameSync(tmp, to);
    }
  };
  visit(base);
}

/** Absolute path of the rendered mp4, rebuilt from its media url so job.json survives the output folder moving. */
function renderFile(c: ClipState): string | undefined {
  if (c.render.status !== "done" || !c.render.url) return undefined;
  const rel = decodeURIComponent(
    c.render.url.replace(/^\/api\/media\//, "").split("?")[0]!,
  );
  return path.join(workRoot(), rel);
}

function segFile(jobDir: string, c: ClipState, job: JobState) {
  // reconstruct the on-disk name from the media url so job.json stays portable
  const rel = decodeURIComponent(c.segment!.url.replace(/^\/api\/media\//, ""));
  return path.join(workRoot(), rel);
}

function fmtDur(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

declare global {
  // eslint-disable-next-line no-var
  var __capyJobs: JobManager | undefined;
}

/**
 * Where a rendered clip's mp4 actually is: the stored path if it still exists, else the same file
 * name inside the job's folder under the current OUTPUT_ROOT (the folder is portable, the stored
 * absolute path is not). Undefined when neither exists.
 */
export function renderedFile(job: JobState, c: ClipState): string | undefined {
  const stored = c.render.file;
  if (!stored) return undefined;
  if (existsSync(stored)) return stored;
  const local = path.join(workRoot(), job.dir, path.basename(stored));
  return existsSync(local) ? local : undefined;
}

export function jobs(): JobManager {
  if (!globalThis.__capyJobs) globalThis.__capyJobs = new JobManager();
  // dev reloads re-evaluate this module: keep the live state but pick up the new methods
  else if (
    Object.getPrototypeOf(globalThis.__capyJobs) !== JobManager.prototype
  )
    Object.setPrototypeOf(globalThis.__capyJobs, JobManager.prototype);
  return globalThis.__capyJobs;
}
