import { z } from "zod";
import type { ContentReview, Platform, PostText } from "./types";

/** Serializable publication snapshots; hashing and filesystem access live on the server. */
export interface PublishPackageInput {
  id: string;
  artifact: { id: string; checksum: string; projectId?: string; revision?: number };
  text: PostText;
  textHash: string;
  thumbnail?: { revision: string; checksum: string };
  platform: Platform;
  accountId: string;
  review?: ContentReview;
  policyVersion: string;
  mediaOptionsHash: string;
}
export interface PublishPackage extends PublishPackageInput { packageHash: string }
export interface PublicationDecision { kind: "human" | "human_override"; packageHash: string; at: number }
export interface PublicationContext {
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
  automaticPolicy?: { enabled: boolean; policyVersion: string; accountId: string };
  packageHash: string;
}
/** Persisted snapshots are untrusted input; legacy/malformed records never authorize a side effect. */
export const PublishPackageSchema = z.strictObject({
  id:z.string().min(1),
  artifact:z.strictObject({id:z.string().min(1),checksum:z.string().regex(/^[a-f0-9]{64}$/),projectId:z.string().optional(),revision:z.number().int().nonnegative().optional()}),
  text:z.strictObject({title:z.string().optional(),description:z.string().optional(),tags:z.array(z.string()).optional(),caption:z.string().optional()}),
  textHash:z.string().regex(/^[a-f0-9]{64}$/),
  thumbnail:z.strictObject({revision:z.string().min(1),checksum:z.string().regex(/^[a-f0-9]{64}$/)}).optional(),
  platform:z.enum(["youtube","instagram","tiktok"]),accountId:z.string().min(1),
  review:z.strictObject({verdict:z.enum(["ok","caution","block"]),summary:z.string(),issues:z.array(z.strictObject({kind:z.string(),note:z.string()})),title:z.string().optional(),at:z.number().finite()}).optional(),
  policyVersion:z.string().min(1),mediaOptionsHash:z.string().regex(/^[a-f0-9]{64}$/),packageHash:z.string().regex(/^[a-f0-9]{64}$/),
});
export interface EligibilityResult { allowed: boolean; reasons: string[] }
export function evaluatePublication(pkg: PublishPackage | undefined, c: PublicationContext): EligibilityResult {
  const reasons: string[] = [];
  if (!pkg) return {allowed:false,reasons:["Missing publication revision; review required"]};
  if (!PublishPackageSchema.safeParse(pkg).success) return {allowed:false,reasons:["Invalid publication snapshot; review required"]};
  if (!pkg.artifact.checksum || !c.artifactHash) reasons.push("Media missing or uncertain");
  else if (pkg.artifact.checksum !== c.artifactHash) reasons.push("Media changed; new decision required");
  if (pkg.textHash !== c.textHash) reasons.push("Posting text changed");
  if (pkg.thumbnail?.checksum !== c.thumbnailHash || pkg.thumbnail?.revision !== c.thumbnailRevision) reasons.push("Thumbnail changed or missing");
  if (pkg.mediaOptionsHash !== c.mediaOptionsHash) reasons.push("Media options changed");
  if (!pkg.accountId || !c.connectedAccountId) reasons.push("Connected destination identity missing");
  else if (pkg.accountId !== c.connectedAccountId || pkg.platform !== c.platform) reasons.push("Destination account changed");
  if (pkg.policyVersion !== c.policyVersion) reasons.push("Publication policy changed");
  if (pkg.packageHash !== c.packageHash) reasons.push("Publication snapshot changed");
  if (c.reviewHash !== c.packageReviewHash) reasons.push("Review changed or stale");
  const human = c.approval && c.approval.packageHash === pkg.packageHash;
  const automatic = c.automaticPolicy?.enabled && c.automaticPolicy.policyVersion === pkg.policyVersion && c.automaticPolicy.accountId === pkg.accountId;
  if (!human && !automatic) reasons.push("Publication decision missing or stale");
  if (c.review?.verdict === "block" && !(human && c.approval?.kind === "human_override")) reasons.push("Content review blocked publication");
  if (!human && c.review?.verdict !== "ok") reasons.push("Automatic publication requires a successful review");
  return {allowed:reasons.length===0,reasons};
}
