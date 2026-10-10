import { z } from "zod";
import { PublishPackageSchema } from "./publication";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
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
  capturedAt: z.number().finite().nonnegative(),
  source: z.strictObject({
    kind: z.enum(["creator-clip", "studio", "story", "manual", "unknown"]),
    jobId: z.string().optional(),
    projectId: z.string().optional(),
    revision: z.number().int().nonnegative().optional(),
  }),
  recipe: z.discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("unattributed"),
      reason: z.string().min(1).max(500),
    }),
    z.strictObject({
      state: z.literal("manual"),
      reason: z.string().min(1).max(500),
    }),
  ]),
});
export type PublicationAttributionSnapshot = z.infer<
  typeof PublicationAttributionSchema
>;
