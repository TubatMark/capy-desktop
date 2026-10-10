import { z } from "zod";
import type { ContentReview, Platform, PostText } from "./types";

/** Serializable publication snapshots; hashing and filesystem access live on the server. */
export type PublicationDeliveryOptions =
  | { mode: "public"; privacyPolicy: "public" }
  | {
      mode: "scheduled";
      privacyPolicy: "private-until-publish";
      publishAt: number;
      uploadAheadMinutes: number;
      schedulePolicy: "youtube-schedule-v1";
    }
  | { mode: "inbox"; privacyPolicy: "assisted-inbox" }
  | { mode: "direct"; privacyPolicy: "public-or-self-only" };

export interface PublishPackageInput {
  id: string;
  artifact: {
    id: string;
    checksum: string;
    projectId?: string;
    revision?: number;
  };
  text: PostText;
  textHash: string;
  thumbnail?: {
    revision: string;
    checksum: string;
    designId?: string;
    versionId?: string;
    sourceIdentity?: import("./thumbnails").ThumbnailSourceRef;
    sourceFrame?: {
      id: string;
      assetId: string;
      sourceUs: number;
      renderUs: number;
      checksum: string;
    };
    /** "original" designs: the source video's own thumbnail instead of a clip frame. */
    sourceThumbnail?: import("./thumbnails").SourceThumbnailRef;
  };
  platform: Platform;
  accountId: string;
  review?: ContentReview;
  policyVersion: string;
  mediaOptionsHash: string;
  deliveryOptions: PublicationDeliveryOptions;
}
export interface PublishPackage extends PublishPackageInput {
  packageHash: string;
}
export interface PublicationDecision {
  kind: "human" | "human_override";
  packageHash: string;
  at: number;
}
export interface PublicationContext {
  destinationChecks?: string[];
  scheduledSlotAt?: number;
  automationChecks?: { required: boolean; reasons: string[] };
  studio?: {
    currentRevision?: number;
    projectId?: string;
    artifactId?: string;
    artifactRevision?: number;
    artifactChecksum?: string;
  };
  deliveryOptions: PublicationDeliveryOptions;
  artifactHash?: string;
  textHash: string;
  thumbnailHash?: string;
  thumbnailRevision?: string;
  mediaOptionsHash: string;
  connectedAccountId?: string;
  platform: Platform;
  review?: ContentReview;
  reviewHash: string;
  packageReviewHash: string;
  policyVersion: string;
  approval?: PublicationDecision;
  automaticPolicy?: {
    enabled: boolean;
    policyVersion: string;
    accountId: string;
  };
  packageHash: string;
}
/** Persisted snapshots are untrusted input; legacy/malformed records never authorize a side effect. */
export const PublicationDecisionSchema = z.strictObject({
  kind: z.enum(["human", "human_override"]),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.number().finite().nonnegative(),
});
export const AutomaticPublicationPolicySchema = z.strictObject({
  enabled: z.boolean(),
  policyVersion: z.string().min(1),
  accountId: z.string().min(1),
});
export const PublicationDeliveryOptionsSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("public"),
    privacyPolicy: z.literal("public"),
  }),
  z.strictObject({
    mode: z.literal("scheduled"),
    privacyPolicy: z.literal("private-until-publish"),
    publishAt: z.number().int().positive(),
    uploadAheadMinutes: z.number().int().min(1).max(1440),
    schedulePolicy: z.literal("youtube-schedule-v1"),
  }),
  z.strictObject({
    mode: z.literal("inbox"),
    privacyPolicy: z.literal("assisted-inbox"),
  }),
  z.strictObject({
    mode: z.literal("direct"),
    privacyPolicy: z.literal("public-or-self-only"),
  }),
]);
export const PublishPackageSchema = z.strictObject({
  deliveryOptions: PublicationDeliveryOptionsSchema,
  id: z.string().min(1),
  artifact: z.strictObject({
    id: z.string().min(1),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    projectId: z.string().optional(),
    revision: z.number().int().nonnegative().optional(),
  }),
  text: z.strictObject({
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    caption: z.string().optional(),
  }),
  textHash: z.string().regex(/^[a-f0-9]{64}$/),
  thumbnail: z
    .strictObject({
      revision: z.string().min(1),
      checksum: z.string().regex(/^[a-f0-9]{64}$/),
      designId: z.string().min(1).optional(),
      versionId: z.string().min(1).optional(),
      sourceIdentity: z
        .discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("project"),
            projectId: z.string().min(1),
            revision: z.number().int().nonnegative(),
            renderId: z.string().min(1),
            renderChecksum: z.string().regex(/^[a-f0-9]{64}$/),
          }),
          z.strictObject({
            kind: z.literal("legacy"),
            jobId: z.string().min(1),
            clipN: z.number().int().positive(),
            revision: z.number().int().nonnegative(),
            renderChecksum: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        ])
        .optional(),
      sourceFrame: z
        .strictObject({
          id: z.string().min(1),
          assetId: z.string().min(1),
          sourceUs: z.number().finite().nonnegative(),
          renderUs: z.number().finite().nonnegative(),
          checksum: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .optional(),
      sourceThumbnail: z
        .strictObject({
          videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
          url: z
            .string()
            .regex(/^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/[a-z]+\.jpg$/),
          checksum: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .optional(),
    })
    .optional(),
  platform: z.enum(["youtube", "instagram", "tiktok"]),
  accountId: z.string().min(1),
  review: z
    .strictObject({
      verdict: z.enum(["ok", "caution", "block"]),
      summary: z.string(),
      issues: z.array(z.strictObject({ kind: z.string(), note: z.string() })),
      title: z.string().optional(),
      at: z.number().finite(),
    })
    .optional(),
  policyVersion: z.string().min(1),
  mediaOptionsHash: z.string().regex(/^[a-f0-9]{64}$/),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface EligibilityResult {
  allowed: boolean;
  reasons: string[];
}
export function evaluatePublication(
  pkg: PublishPackage | undefined,
  c: PublicationContext,
): EligibilityResult {
  const reasons: string[] = [];
  if (!pkg)
    return {
      allowed: false,
      reasons: ["Missing publication revision; review required"],
    };
  if (!PublishPackageSchema.safeParse(pkg).success)
    return {
      allowed: false,
      reasons: ["Invalid publication snapshot; review required"],
    };
  if (pkg.artifact.projectId || c.studio) {
    if (
      !c.studio ||
      !pkg.artifact.projectId ||
      pkg.artifact.projectId !== c.studio.projectId ||
      pkg.artifact.revision !== c.studio.currentRevision
    )
      reasons.push("Studio project revision changed; export and review again");
    if (
      !c.studio ||
      pkg.artifact.id !== c.studio.artifactId ||
      pkg.artifact.revision !== c.studio.artifactRevision ||
      pkg.artifact.checksum !== c.studio.artifactChecksum
    )
      reasons.push("Studio render identity changed or missing");
  }
  if (!pkg.artifact.checksum || !c.artifactHash)
    reasons.push("Media missing or uncertain");
  else if (pkg.artifact.checksum !== c.artifactHash)
    reasons.push("Media changed; new decision required");
  if (pkg.textHash !== c.textHash) reasons.push("Posting text changed");
  if (
    pkg.thumbnail?.checksum !== c.thumbnailHash ||
    pkg.thumbnail?.revision !== c.thumbnailRevision
  )
    reasons.push("Thumbnail changed or missing");
  const options = PublicationDeliveryOptionsSchema.parse(pkg.deliveryOptions);
  if (
    (pkg.platform === "tiktok") ===
      ["public", "scheduled"].includes(options.mode) ||
    (options.mode === "scheduled" && pkg.platform !== "youtube")
  )
    reasons.push("Invalid destination delivery mode");
  if (
    options.mode !== c.deliveryOptions.mode ||
    options.privacyPolicy !== c.deliveryOptions.privacyPolicy
  )
    reasons.push("Destination delivery options changed");
  if (
    options.mode === "scheduled" &&
    (c.deliveryOptions.mode !== "scheduled" ||
      options.publishAt !== c.deliveryOptions.publishAt ||
      options.uploadAheadMinutes !== c.deliveryOptions.uploadAheadMinutes ||
      options.schedulePolicy !== c.deliveryOptions.schedulePolicy ||
      c.scheduledSlotAt !== options.publishAt)
  )
    reasons.push(
      "Remote schedule changed; a new explicit decision is required",
    );
  reasons.push(...(c.destinationChecks ?? []));
  if (pkg.mediaOptionsHash !== c.mediaOptionsHash)
    reasons.push("Media options changed");
  if (!pkg.accountId || !c.connectedAccountId)
    reasons.push("Connected destination identity missing");
  else if (
    pkg.accountId !== c.connectedAccountId ||
    pkg.platform !== c.platform
  )
    reasons.push("Destination account changed");
  if (pkg.policyVersion !== c.policyVersion)
    reasons.push("Publication policy changed");
  if (pkg.packageHash !== c.packageHash)
    reasons.push("Publication snapshot changed");
  if (c.reviewHash !== c.packageReviewHash)
    reasons.push("Review changed or stale");
  if (c.automationChecks?.required) reasons.push(...c.automationChecks.reasons);
  const decision = PublicationDecisionSchema.safeParse(c.approval);
  const human =
    decision.success && decision.data.packageHash === pkg.packageHash;
  const policy = AutomaticPublicationPolicySchema.safeParse(c.automaticPolicy);
  const automatic =
    policy.success &&
    policy.data.enabled === true &&
    policy.data.policyVersion === pkg.policyVersion &&
    policy.data.accountId === pkg.accountId;
  if (!human && !automatic)
    reasons.push("Publication decision missing or stale");
  if (
    c.review?.verdict === "block" &&
    !(human && decision.success && decision.data.kind === "human_override")
  )
    reasons.push("Content review blocked publication");
  if (!human && c.review?.verdict !== "ok")
    reasons.push("Automatic publication requires a successful review");
  return { allowed: reasons.length === 0, reasons };
}
