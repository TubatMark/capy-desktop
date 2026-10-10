import { runtimeStore } from "./db/runtime";
import type { ProjectDocument, RenderArtifact } from "../lib/studio/types";
import { StudioQueueSourceSchema } from "../lib/queue-source";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PublishPackageSchema, evaluatePublication, type PublishPackage, type PublishPackageInput, type PublicationContext, type PublicationDeliveryOptions } from "../lib/publication";
import type { QueueEntry, Platform } from "../lib/types";
import { loadAccounts } from "./accounts";
export { evaluatePublication } from "../lib/publication";
export const PUBLICATION_POLICY_VERSION = "publication-v2";
/** Stable manifest encoding ignores object key order; array order remains meaningful. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const hashManifest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function hashFile(file?: string): string | undefined { try { return file ? createHash("sha256").update(readFileSync(file)).digest("hex") : undefined; } catch { return undefined; } }
export const packageDigest = (input: Partial<PublishPackageInput>) => { const {id: _id,...manifest}=input; return hashManifest(manifest); };
export function buildPublishPackage(input: PublishPackageInput): PublishPackage {
  const snapshot = structuredClone(input);
  return PublishPackageSchema.parse({ ...snapshot, packageHash: packageDigest(snapshot) });
}
export function connectedAccountId(platform: Platform): string | undefined {
  const a = loadAccounts()[platform];
  if (!a.tokens?.accessToken || a.needsReconnect) return undefined;
  return (platform === "instagram" ? a.igUserId : a.account?.id) || undefined;
}
/** Fixed approved visibility policy: inbox stays assisted; direct may only be public or self-only. */
export function deliveryOptions(platform: Platform): PublicationDeliveryOptions {
  if (platform !== "tiktok") return {mode:"public",privacyPolicy:"public"};
  return loadAccounts().tiktok.mode === "direct"
    ? {mode:"direct",privacyPolicy:"public-or-self-only"}
    : {mode:"inbox",privacyPolicy:"assisted-inbox"};
}
export const mediaOptions = (e: QueueEntry) => hashManifest({fp:e.fp,thumbAt:e.thumbAt,madeForKids:e.madeForKids});
export function publicationContext(e: QueueEntry, files = e.publicationFiles, accountId = connectedAccountId(e.platform)): PublicationContext {
  const pkg = e.publishPackage;
  const { packageHash: _hash, ...snapshot } = pkg ?? {};
  const source=StudioQueueSourceSchema.safeParse(e.source);
  const artifact=source.success ? runtimeStore().get<RenderArtifact>("renders",source.data.renderId)?.value : undefined;
  const current=source.success ? runtimeStore().get<ProjectDocument>("projects",source.data.projectId)?.value : undefined;
  const studio=e.source || pkg?.artifact.projectId ? {currentRevision:current?.revision,projectId:source.success?source.data.projectId:undefined,artifactId:artifact?.id,artifactRevision:artifact?.revision,artifactChecksum:artifact && source.success && artifact.projectId===source.data.projectId && artifact.revision===source.data.revision && artifact.checksum===source.data.renderChecksum ? artifact.checksum:undefined}:undefined;
  const actualThumb=hashFile(files?.thumbFile);
  return {studio,deliveryOptions:deliveryOptions(e.platform),artifactHash:hashFile(files?.file),textHash:hashManifest(e.text),thumbnailHash:hashFile(files?.thumbFile),thumbnailRevision:actualThumb && pkg?.thumbnail?.designId && pkg.thumbnail.checksum===actualThumb ? pkg.thumbnail.revision : actualThumb,mediaOptionsHash:mediaOptions(e),connectedAccountId:accountId,platform:e.platform,review:e.aiReview,reviewHash:hashManifest(e.aiReview),packageReviewHash:hashManifest(pkg?.review),policyVersion:PUBLICATION_POLICY_VERSION,approval:e.publicationDecision,packageHash:packageDigest(snapshot)};
}
export function eligibility(e: QueueEntry, files = e.publicationFiles, accountId = connectedAccountId(e.platform)) { return evaluatePublication(e.publishPackage, publicationContext(e,files,accountId)); }
/** A fresh explicit human decision can adopt legacy media only after resolving and hashing it. */
export function decide(e: QueueEntry, override: boolean, now: Date): QueueEntry {
  const checksum = hashFile(e.publicationFiles?.file);
  const accountId = connectedAccountId(e.platform);
  if (!checksum || !accountId || (e.publicationFiles?.thumbFile && !hashFile(e.publicationFiles.thumbFile))) return e;
  const thumbnailHash = hashFile(e.publicationFiles?.thumbFile);
  const studio=StudioQueueSourceSchema.safeParse(e.source);
  if(e.source && !studio.success)return e;
  const identity=studio.success ? {id:studio.data.renderId,projectId:studio.data.projectId,revision:studio.data.revision,checksum} : {id:e.key,checksum};
  const thumbnail=thumbnailHash && e.publishPackage?.thumbnail?.checksum===thumbnailHash ? e.publishPackage.thumbnail : thumbnailHash ? {revision:thumbnailHash,checksum:thumbnailHash}:undefined;
  const pkg = buildPublishPackage({deliveryOptions:deliveryOptions(e.platform),id:`${e.key}:${now.getTime()}`,artifact:identity,text:e.text,textHash:hashManifest(e.text),thumbnail,platform:e.platform,accountId,review:e.aiReview,policyVersion:PUBLICATION_POLICY_VERSION,mediaOptionsHash:mediaOptions(e)});
  return {...e,publishPackage:pkg,publicationDecision:{kind:override ? "human_override" : "human",packageHash:pkg.packageHash,at:now.getTime()}};
}
