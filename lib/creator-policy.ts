import { z } from "zod";
export const AutomationControlsSchema = z.strictObject({
  monitorPaused: z.boolean(),
  renderPaused: z.boolean(),
  postPaused: z.boolean(),
  globalStop: z.boolean(),
});
export type AutomationControls = z.infer<typeof AutomationControlsSchema>;
export const DEFAULT_CONTROLS: AutomationControls = {
  monitorPaused: false,
  renderPaused: false,
  postPaused: false,
  globalStop: false,
};
export const CreatorPolicySchema = z
  .strictObject({
    mode: z.enum([
      "disabled",
      "manual",
      "automatic_drafts",
      "automatic_publish",
    ]),
    clips: z.number().int().min(1).max(8),
    minDurationSec: z.number().min(0).max(86400),
    maxDurationSec: z.number().min(1).max(86400),
    includeTopics: z.array(z.string().trim().min(1).max(100)).max(20),
    excludeTopics: z.array(z.string().trim().min(1).max(100)).max(20),
    sourceMethods: z
      .array(z.enum(["uploads-playlist", "videos-tab"]))
      .min(1)
      .max(2),
    allowArchives: z.boolean(),
    allowShortSources: z.boolean(),
    maxBlackRatio: z.number().min(0).max(1),
    maxFrozenRatio: z.number().min(0).max(1),
    maxJobUsd: z.number().min(0).max(100),
    maxDayUsd: z.number().min(0).max(1000),
    language: z.string().trim().max(30),
    destinationAccountIds: z.array(z.string().min(1).max(200)).max(10),
    dailyClipCap: z.number().int().min(1).max(100),
    targetQueueDays: z.number().int().min(1).max(7),
    maxBacklogDays: z.number().int().min(1).max(30),
    destinationDailySlots: z.number().int().min(1).max(100),
    freshnessHours: z.number().min(1).max(8760),
    expireFreshness: z.boolean(),
    requireAudio: z.boolean(),
    requireModelReview: z.boolean(),
    editTemplate: z.enum(["bold-portrait-v1", "clean-portrait-v1"]),
    thumbnailGeneration: z.enum(["manual", "automatic"]),
    thumbnailTemplate: z.literal("source-frame-v1"),
    thumbnailRequired: z.boolean(),
    optionalThumbnailFallback: z.enum(["none", "source_frame"]),
    recipeId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine(
    (p) => p.maxDurationSec >= p.minDurationSec,
    "Maximum duration must be at least minimum",
  )
  .refine(
    (p) => p.maxBacklogDays >= p.targetQueueDays,
    "Maximum backlog must cover target queue",
  );
export type CreatorPolicy = z.infer<typeof CreatorPolicySchema>;
export const CreatorPoliciesSchema = z
  .record(z.string().min(1).max(200), CreatorPolicySchema)
  .refine((v) => Object.keys(v).length <= 1000, "Too many creator policies");
export const DEFAULT_CREATOR_POLICY: CreatorPolicy = {
  mode: "manual",
  clips: 3,
  minDurationSec: 120,
  maxDurationSec: 86400,
  includeTopics: [],
  excludeTopics: [],
  sourceMethods: ["uploads-playlist", "videos-tab"],
  allowArchives: true,
  allowShortSources: true,
  maxBlackRatio: 0.9,
  maxFrozenRatio: 1,
  maxJobUsd: 1,
  maxDayUsd: 5,
  language: "",
  destinationAccountIds: [],
  dailyClipCap: 6,
  targetQueueDays: 3,
  maxBacklogDays: 7,
  destinationDailySlots: 2,
  freshnessHours: 72,
  expireFreshness: false,
  requireAudio: false,
  requireModelReview: true,
  editTemplate: "bold-portrait-v1",
  thumbnailGeneration: "manual",
  thumbnailTemplate: "source-frame-v1",
  thumbnailRequired: false,
  optionalThumbnailFallback: "none",
};
export interface CreatorRecipe {
  id: string;
  version: 1;
  editTemplate: CreatorPolicy["editTemplate"];
  thumbnailTemplate: CreatorPolicy["thumbnailTemplate"];
  clips: number;
  language: string;
  createdAt: number;
}
export interface CreatorCandidate {
  id: string;
  channelId: string;
  title: string;
  foundAt: number;
  durationSec?: number;
  priority?: number;
  sourceMethod?: "uploads-playlist" | "videos-tab";
  isArchive?: boolean;
}
export interface CreatorWorkInput {
  existingJobConflict?: string;
  candidate: CreatorCandidate;
  policy: CreatorPolicy;
  now: number;
  manual?: boolean;
  sourceAllowed: boolean;
  destinationAccountId?: string;
  capacity: {
    unpublished: number;
    reservedClips: number;
    destinationDailySlots: number;
    targetDays: number;
    maxBacklogDays: number;
    remainingRenderClips: number;
  };
}
export interface WorkDecision {
  kind: "proceed" | "defer" | "skip";
  candidateId: string;
  reason: string;
  recipe?: CreatorRecipe;
  budget: { clips: number };
  destination?: string;
}
export interface MediaQualityReport {
  artifactId: string;
  checksum: string;
  revision: number;
  reviewVersion: string;
  policy: {
    requireAudio: boolean;
    aspect?: string;
    maxBlackRatio: number;
    maxFrozenRatio?: number;
  };
  at: number;
  passed: boolean;
  checks: { id: string; pass: boolean; reason: string; measured?: number }[];
  modelReview: {
    status:
      "not_requested" | "unavailable" | "passed" | "blocked" | "needs_review";
    reason: string;
  };
  supplementaryReview?: import("./types").ContentReview;
}
export interface AutomationHealth {
  online: boolean;
  heartbeat?: number;
  activeStage?: string;
  oldestPendingAt?: number;
  lastSuccessAt?: number;
  nextPostAt?: number;
  pending: number;
  disk: { availableBytes?: number; reserveBytes: number; error?: string };
  budget: {
    reservedUsd: number;
    maxDayUsd: number;
    requests: number;
    maxDayRequests: number;
    unknown: number;
  };
  accounts: {
    id?: string;
    platform: string;
    connected: boolean;
    needsReconnect: boolean;
  }[];
  controls: AutomationControls;
  reasons: { id: string; reason: string; at: number }[];
  policies: Record<string, CreatorPolicy>;
  creatorNames: Record<string, string>;
  publication: { enabled: false; reason: string };
}

export const MediaQualityReportSchema = z
  .strictObject({
    artifactId: z.string().min(1),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().nonnegative(),
    reviewVersion: z.literal("deterministic-media-v1"),
    at: z.number().finite().nonnegative(),
    passed: z.boolean(),
    policy: z.strictObject({
      requireAudio: z.boolean(),
      aspect: z.string().optional(),
      maxBlackRatio: z.number().min(0).max(1),
      maxFrozenRatio: z.number().min(0).max(1).optional(),
    }),
    checks: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          pass: z.boolean(),
          reason: z.string().min(1),
          measured: z.number().finite().optional(),
        }),
      )
      .max(30),
    modelReview: z.strictObject({
      status: z.enum([
        "not_requested",
        "unavailable",
        "passed",
        "blocked",
        "needs_review",
      ]),
      reason: z.string().min(1),
    }),
    supplementaryReview: z
      .strictObject({
        verdict: z.enum(["ok", "caution", "block"]),
        summary: z.string(),
        issues: z.array(z.strictObject({ kind: z.string(), note: z.string() })),
        title: z.string().optional(),
        at: z.number().finite(),
      })
      .optional(),
  })
  .refine(
    (r) =>
      !r.passed ||
      (r.checks.every((c) => c.pass) &&
        [
          "identity",
          "duration",
          "aspect",
          "decode",
          "black",
          "audio",
          "frozen",
          "captions",
        ].every((id) => r.checks.some((c) => c.id === id))),
    "A passing report requires every measured technical check",
  )
  .refine(
    (r) => new Set(r.checks.map((c) => c.id)).size === r.checks.length,
    "Duplicate media check",
  );
