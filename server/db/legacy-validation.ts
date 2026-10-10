import { z } from "zod";
const number = z.number().finite();
const string = z.string();
const text = z
  .object({
    ytTitle: string,
    description: string,
    hashtags: z.array(string),
    tags: z.array(string).optional(),
    edited: z.boolean().optional(),
  })
  .passthrough();
const render = z
  .object({
    status: z.enum(["none", "queued", "rendering", "done", "error", "stale"]),
    file: string.optional(),
    url: string.optional(),
    error: string.optional(),
    thumbUrl: string.optional(),
    textUrl: string.optional(),
    progress: number.optional(),
    remaining: number.optional(),
    startedAt: number.optional(),
    tookMs: number.optional(),
  })
  .passthrough();
const review = z
  .object({
    verdict: z.enum(["ok", "caution", "block"]),
    summary: string,
    issues: z.array(z.object({ kind: string, note: string })),
    at: number,
  })
  .passthrough();
const seo = z
  .object({
    score: number,
    checks: z.array(
      z.object({
        id: string,
        label: string,
        weight: number,
        pass: z.boolean(),
        tip: string.optional(),
      }),
    ),
    at: number,
  })
  .passthrough();
const look = z.object({
  size: number,
  bottom: number,
  wordsPerLine: number,
  text: string,
  highlight: string,
  outline: string,
  outlineWidth: number,
  box: z.boolean(),
  hook: z.object({ size: number, text: string, box: string, top: number }),
  vibe: z.enum(["original", "warm", "cool", "vivid", "film", "mono"]),
});
const settings = z
  .object({
    count: number,
    minSec: number,
    maxSec: number,
    layout: z.enum(["center", "blur"]),
    style: z.enum(["bold", "clean"]),
    captions: z.boolean(),
    hook: z.boolean(),
    maxRes: number,
    look: look.optional(),
    focus: string.optional(),
    model: string.optional(),
    browser: string.optional(),
    lang: string.optional(),
    audience: z.enum(["original", "en-us"]).optional(),
    autoPost: z.boolean().optional(),
  })
  .passthrough();
const clip = z
  .object({
    n: number.int().positive(),
    start: number,
    end: number,
    title: string,
    hook: string,
    reason: string,
    score: number,
    selected: z.boolean(),
    render,
    segment: z
      .object({
        start: number,
        end: number,
        url: string,
        status: z.enum(["queued", "downloading", "done", "error"]),
      })
      .passthrough()
      .optional(),
    publish: text.optional(),
    contentReview: review.optional(),
    seo: seo.optional(),
    review: z
      .object({
        verdict: z.enum(["pass", "fix_hook", "fail"]),
        problem: string.optional(),
      })
      .optional(),
    thumbUrl: string.optional(),
    thumbAt: number.optional(),
    replayPeak: number.optional(),
    captionsTranslated: z.union([z.boolean(), z.literal("error")]).optional(),
    thumbs: z
      .array(z.object({ url: string, at: number }).passthrough())
      .optional(),
  })
  .passthrough();
export const jobSchema = z
  .object({
    id: string.min(1),
    videoId: string.min(1),
    url: string,
    dir: string
      .min(1)
      .refine(
        (dir) => dir !== "." && dir !== ".." && !/[\\/]/.test(dir),
        "Expected one safe relative directory",
      ),
    status: z.enum(["queued", "analyzing", "preparing", "ready", "error"]),
    stage: z.enum(["meta", "captions", "pick", "segments", "done"]),
    stageStartedAt: number,
    title: string.optional(),
    channel: string.optional(),
    duration: number.optional(),
    language: string.optional(),
    startedAt: number.optional(),
    tookMs: number.optional(),
    error: string.optional(),
    sourceLang: string.optional(),
    wordCount: number.optional(),
    pickCostUsd: number.optional(),
    transcriptSource: z.enum(["cache", "captions", "whisper"]).optional(),
    createdAt: number,
    settings,
    estimate: z.object({
      stageRemaining: number,
      totalRemaining: number,
      progress: number,
    }),
    clips: z.array(clip),
    log: z.array(
      z.object({
        t: number,
        stage: z.enum([
          "meta",
          "captions",
          "pick",
          "segments",
          "done",
          "render",
          "error",
        ]),
        msg: string,
      }),
    ),
    translated: z.array(z.object({ start: number, end: number })).optional(),
    automation: z.object({ channelId: string, channelName: string }).optional(),
  })
  .passthrough();
export const watchSchema = z
  .object({
    channels: z.array(
      z
        .object({
          id: string,
          name: string,
          url: string,
          enabled: z.boolean(),
          addedAt: number,
          handle: string.optional(),
          lastCheckedAt: number.optional(),
          lastError: string.optional(),
          seen: z.array(string),
          pending: z.array(
            z.object({
              id: string,
              title: string,
              duration: number.optional(),
              foundAt: number,
            }),
          ),
          history: z.array(
            z
              .object({
                videoId: string,
                title: string,
                at: number,
                jobId: string,
                status: z.enum(["processing", "rendered", "error"]),
                error: string.optional(),
                note: string.optional(),
              })
              .passthrough(),
          ),
          settings: z.object({
            clips: number,
            minVideoSec: number,
            perDay: number,
            audience: z.enum(["original", "en-us"]).optional(),
          }),
        })
        .passthrough(),
    ),
    maxPerDay: number,
    intervalMin: number,
    lastCheckAt: number.optional(),
  })
  .passthrough();
export const queueSchema = z.array(
  z
    .object({
      key: string,
      jobId: string,
      n: number.int().positive(),
      platform: z.enum(["youtube", "instagram", "tiktok"]),
      status: z.enum([
        "review",
        "scheduled",
        "posting",
        "posted",
        "needs_action",
        "failed",
        "rejected",
      ]),
      clipTitle: string,
      text: z
        .object({
          title: string.optional(),
          description: string.optional(),
          caption: string.optional(),
          tags: z.array(string).optional(),
        })
        .passthrough(),
      attempts: number,
      history: z.array(z.object({ t: number, msg: string })),
      createdAt: number,
      updatedAt: number,
      aiReview: review.optional(),
      seo: seo.optional(),
      fp: string.optional(),
      progress: z.record(string, string).optional(),
      madeForKids: z.boolean().optional(),
      link: string.optional(),
      videoTitle: string.optional(),
      videoUrl: string.optional(),
      thumbUrl: string.optional(),
      thumbAt: number.optional(),
      slotAt: number.optional(),
      nextTryAt: number.optional(),
      authBlocked: z.boolean().optional(),
      result: z
        .object({
          id: string.optional(),
          url: string.optional(),
          note: string.optional(),
        })
        .optional(),
      error: string.optional(),
      publicationFiles: z
        .object({ file: string, thumbFile: string.optional() })
        .optional(),
    })
    .passthrough(),
);
export function validateLegacy(
  kind: string,
  id: string,
  body: unknown,
  directory?: string,
): void {
  if (kind === "legacy-jobs") {
    const job = jobSchema.parse(body);
    if (directory !== undefined && job.dir !== directory)
      throw Error(
        `Job directory identity mismatch: ${job.dir} != ${directory}`,
      );
  } else if (id === "watch") watchSchema.parse(body);
  else if (id === "queue") queueSchema.parse(body);
  else throw Error(`Unknown legacy kind ${kind}:${id}`);
}
