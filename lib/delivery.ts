import { z } from "zod";
import { PublishPackageSchema } from "./publication";
export const DeliveryStateSchema = z.enum([
  "queued",
  "uploading",
  "uploaded",
  "processing",
  "scheduled",
  "public",
  "needs-action",
  "failed",
  "delivery-unknown",
]);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;
export const RemoteVisibilitySchema = z.enum([
  "unknown",
  "private",
  "unlisted",
  "inbox",
  "scheduled",
  "public",
]);
export const ThumbnailDeliverySchema = z.strictObject({
  status: z.enum([
    "not-requested",
    "pending",
    "accepted",
    "refused",
    "unknown",
  ]),
  checksum: z.string().optional(),
  attemptedAt: z.number().optional(),
  observedAt: z.number().optional(),
  httpStatus: z.number().optional(),
});
export const DeliveryRecordSchema = z.strictObject({
  version: z.literal(1),
  generation: z.number().int().nonnegative(),
  checkpoint: z.number().int().nonnegative(),
  handleCheckpoint: z
    .strictObject({
      sequence: z.number().int().positive(),
      operationId: z.string(),
      intentRevision: z.number().int().nonnegative(),
      generation: z.number().int().nonnegative(),
    })
    .optional(),
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  queueKey: z.string().min(1),
  package: PublishPackageSchema,
  attribution: z.strictObject({
    packageHash: z.string(),
    attributionHash: z.string(),
  }),
  state: DeliveryStateSchema,
  phase: z.enum([
    "not-started",
    "destination-pinned",
    "session-create-intent",
    "initialization-rejected",
    "session-known",
    "transfer-intent",
    "media-accepted",
    "publish-intent",
    "publication-observed",
  ]),
  visibility: RemoteVisibilitySchema,
  remoteStatus: z.string().max(100).optional(),
  observedAt: z.number().optional(),
  firstPublicAt: z.number().optional(),
  publishedAt: z.number().optional(),
  publicationIds: z.array(z.string().min(1).max(200)).max(100),
  thumbnail: ThumbnailDeliverySchema,
  attempts: z.number().int().nonnegative(),
  nextTryAt: z.number().optional(),
  retryClass: z
    .enum(["transient", "rate-limit", "quota", "auth", "permanent"])
    .optional(),
  reason: z.string().max(500).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;
/** Public facts only. Session credentials and server paths never cross this boundary. */
export interface DeliveryAttributionProjection {
  id: string;
  revision: number;
  packageId: string;
  packageHash: string;
  attribution: DeliveryRecord["attribution"];
  platform: DeliveryRecord["package"]["platform"];
  accountId: string;
  artifact: DeliveryRecord["package"]["artifact"];
  selectedThumbnail: DeliveryRecord["package"]["thumbnail"];
  thumbnail: DeliveryRecord["thumbnail"];
  state: DeliveryState;
  visibility: DeliveryRecord["visibility"];
  publicationIds: string[];
  remoteStatus?: string;
  observedAt?: number;
  firstPublicAt?: number;
  publishedAt?: number;
  nextTryAt?: number;
  retryClass?: DeliveryRecord["retryClass"];
  reason?: string;
}
