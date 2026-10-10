import { z } from "zod";
import { PublishPackageSchema } from "./publication";
import { CreatorPolicySchema } from "./creator-policy";
import type { DeliveryAttributionProjection } from "./delivery";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.number().finite().nonnegative();
export const RenderSettingsSchema = z.strictObject({
  count: z.number().int().positive(),
  minSec: z.number().nonnegative(),
  maxSec: z.number().positive(),
  layout: z.string().min(1),
  style: z.string().min(1),
  captions: z.boolean(),
  hook: z.boolean(),
  lang: z.string().optional(),
  audience: z.string().optional(),
  lookHash: digest,
});
export const RecipeDefinitionSchema = z.strictObject({
  id: digest,
  version: z.literal(1),
  editTemplate: z.enum(["bold-portrait-v1", "clean-portrait-v1"]),
  thumbnailTemplate: z.literal("source-frame-v1"),
  clips: z.number().int().positive(),
  language: z.string(),
  createdAt: stamp,
});
const RecipeEvidenceSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("unattributed"),
    reason: z.string().min(1).max(500),
  }),
  z.strictObject({
    state: z.literal("manual"),
    reason: z.string().min(1).max(500),
  }),
  z.strictObject({
    state: z.literal("attributed"),
    recipeId: digest,
    definition: RecipeDefinitionSchema,
    policyHash: digest,
    policy: CreatorPolicySchema,
    settings: RenderSettingsSchema,
  }),
]);
export const RenderInputSchema = z.strictObject({
  version: z.literal(1),
  inputHash: digest,
  capturedAt: stamp,
  jobId: z.string().min(1),
  clipN: z.number().int().positive(),
  sourceVideoId: z.string().min(1),
  creatorId: z.string().optional(),
  sourceStartUs: stamp,
  sourceEndUs: stamp,
  settings: RenderSettingsSchema,
  recipe: RecipeEvidenceSchema,
  worker: z
    .strictObject({
      id: z.string(),
      generation: z.number().int().nonnegative(),
    })
    .optional(),
});
export type RenderAttributionInput = z.infer<typeof RenderInputSchema>;
export const RenderProofSchema = z.strictObject({
  version: z.literal(1),
  proofHash: digest,
  input: RenderInputSchema,
  checksum: digest,
  durationUs: z.number().int().positive(),
  completedAt: stamp,
});
export type RenderAttributionProof = z.infer<typeof RenderProofSchema>;
/** Immutable local evidence, never reconstructed from later creator settings. */
export const PublicationAttributionSchema = z.strictObject({
  version: z.literal(1),
  packageId: z.string().min(1),
  packageHash: digest,
  attributionHash: digest,
  platform: PublishPackageSchema.shape.platform,
  accountId: z.string().min(1),
  artifact: PublishPackageSchema.shape.artifact,
  thumbnail: PublishPackageSchema.shape.thumbnail,
  textHash: digest,
  policyVersion: z.string(),
  mediaOptionsHash: digest,
  capturedAt: stamp,
  outputDurationUs: z.number().int().positive().optional(),
  renderProofHash: digest.optional(),
  source: z.strictObject({
    kind: z.enum(["creator-clip", "studio", "story", "manual", "unknown"]),
    jobId: z.string().optional(),
    clipN: z.number().int().positive().optional(),
    projectId: z.string().optional(),
    revision: z.number().int().nonnegative().optional(),
    videoId: z.string().optional(),
    creatorId: z.string().optional(),
    startUs: stamp.optional(),
    endUs: stamp.optional(),
  }),
  recipe: RecipeEvidenceSchema,
});
export type PublicationAttributionSnapshot = z.infer<
  typeof PublicationAttributionSchema
>;
export const METRIC_KEYS = [
  "views",
  "likes",
  "comments",
  "analyticsViews",
  "engagedViews",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export const MetricWindowSchema = z.union([
  z.strictObject({ kind: z.literal("lifetime") }),
  z.strictObject({
    kind: z.literal("calendar"),
    startDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    requestedEndDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    returnedThroughDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    timezone: z.literal("America/Los_Angeles"),
    coverage: z.enum(["observed", "partial", "unknown"]),
  }),
]);
export const AvailableMetricSchema = z.strictObject({
  availability: z.literal("available"),
  value: z.number().finite().nonnegative(),
  metric: z.string(),
  unit: z.enum(["count", "seconds", "minutes", "percent"]),
  source: z.enum(["youtube-data", "youtube-analytics"]),
  measuredAt: stamp,
  window: MetricWindowSchema,
  definitionVersion: z.string(),
});
export type AvailableMetricObservation = z.infer<typeof AvailableMetricSchema>;
export const MetricObservationSchema = z.union([
  AvailableMetricSchema,
  z.strictObject({
    availability: z.literal("unavailable"),
    reason: z.enum([
      "not-published",
      "not-supported",
      "scope-missing",
      "delayed-or-limited",
      "not-returned",
      "auth-required",
      "quota",
      "request-failed",
      "invalid-response",
      "destination-changed",
      "expired",
      "not-refreshed",
    ]),
    metric: z.string(),
    checkedAt: stamp,
    lastAvailable: AvailableMetricSchema.optional(),
  }),
]);
export type MetricObservation = z.infer<typeof MetricObservationSchema>;
export type MetricUnavailableReason = Extract<
  MetricObservation,
  { availability: "unavailable" }
>["reason"];
export const MetricsSchema = z.strictObject(
  Object.fromEntries(
    METRIC_KEYS.map((key) => [key, MetricObservationSchema]),
  ) as Record<MetricKey, typeof MetricObservationSchema>,
);
export type PublicationMetrics = z.infer<typeof MetricsSchema>;
export const RemoteChangeSchema = z.strictObject({
  kind: z.enum(["thumbnail", "media"]),
  reportedAt: stamp,
  changedAt: stamp.optional(),
});
export type RemotePublicationChange = z.infer<typeof RemoteChangeSchema>;
export interface PerformancePublication {
  key: string;
  remoteId?: string;
  delivery: DeliveryAttributionProjection;
  attribution: PublicationAttributionSnapshot;
  metrics: PublicationMetrics;
  remoteChanges: RemotePublicationChange[];
  thumbnailAttribution: "selected-only" | "accepted-unverified" | "uncertain";
}
export interface MetricsRefresh {
  destinationId: string;
  attemptedAt: number;
  completedAt?: number;
  status: "updated" | "partial" | "unavailable" | "skipped";
  reason?: string;
  publications: PerformancePublication[];
  nextRefreshAt?: number;
  continuation?: boolean;
}
export interface RecipeSuggestion {
  axis: "creator" | "topic" | "length" | "template";
  source: "capy-local";
  adoption: "manual";
  text: string;
  href: string;
}
export interface RecipePerformance {
  recipeId: string;
  generatedAt: number;
  publications: PerformancePublication[];
  suggestions: RecipeSuggestion[];
  comparison: { availability: "unavailable"; reason: string };
}
