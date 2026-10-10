import type { QueueEntry } from "../lib/types";
import { PublishPackageSchema, type PublishPackage } from "../lib/publication";
import {
  PublicationAttributionSchema,
  type PublicationAttributionSnapshot,
} from "../lib/performance";
import { runtimeStore } from "./db/runtime";
import { hashManifest, packageDigest } from "./publication-policy";
import { fence } from "./worker/context";
/** Synchronous and immutable. Caller keeps this in its fenced delivery-creation transaction. */
export function capturePublicationAttribution(
  entry: QueueEntry,
  pkg: PublishPackage,
): PublicationAttributionSnapshot {
  return fence(() =>
    runtimeStore().transaction(() => {
      PublishPackageSchema.parse(pkg);
      const { packageHash, ...manifest } = pkg;
      if (
        packageDigest(manifest) !== packageHash ||
        entry.publishPackage?.packageHash !== packageHash ||
        entry.platform !== pkg.platform
      )
        throw Error("Publication attribution identity mismatch");
      const existing = runtimeStore().get(
        "publication-attributions",
        packageHash,
      );
      if (existing) {
        const parsed = PublicationAttributionSchema.safeParse(existing.value);
        if (!parsed.success) throw Error("Invalid publication attribution");
        const { attributionHash, ...body } = parsed.data;
        if (
          hashManifest(body) !== attributionHash ||
          parsed.data.packageHash !== packageHash ||
          parsed.data.accountId !== pkg.accountId ||
          parsed.data.platform !== pkg.platform ||
          hashManifest(parsed.data.artifact) !== hashManifest(pkg.artifact) ||
          hashManifest(parsed.data.thumbnail) !== hashManifest(pkg.thumbnail) ||
          parsed.data.textHash !== pkg.textHash ||
          parsed.data.policyVersion !== pkg.policyVersion ||
          parsed.data.mediaOptionsHash !== pkg.mediaOptionsHash
        )
          throw Error("Publication attribution integrity failure");
        return parsed.data;
      }
      // Current jobs/settings and automation links are not exact render-application evidence.
      // Do not invent historical recipe attribution even when a current recipe happens to match.
      const body = {
        version: 1 as const,
        packageId: pkg.id,
        packageHash,
        platform: pkg.platform,
        accountId: pkg.accountId,
        artifact: pkg.artifact,
        thumbnail: pkg.thumbnail,
        textHash: pkg.textHash,
        policyVersion: pkg.policyVersion,
        mediaOptionsHash: pkg.mediaOptionsHash,
        capturedAt: Date.now(),
        source: entry.source
          ? {
              kind: "studio" as const,
              projectId: entry.source.projectId,
              revision: entry.source.revision,
            }
          : {
              kind: entry.jobId?.startsWith("story-")
                ? ("story" as const)
                : ("unknown" as const),
              jobId: entry.jobId,
            },
        recipe: {
          state: "unattributed" as const,
          reason:
            "Exact artifact-bound recipe application evidence was not recorded",
        },
      };
      const snapshot = PublicationAttributionSchema.parse({
        ...body,
        attributionHash: hashManifest(body),
      });
      runtimeStore().put("publication-attributions", packageHash, snapshot);
      return snapshot;
    }),
  );
}
export function getPublicationAttribution(
  packageHash: string,
): PublicationAttributionSnapshot | undefined {
  const row = runtimeStore().get("publication-attributions", packageHash);
  if (!row) return;
  const value = PublicationAttributionSchema.parse(row.value),
    { attributionHash, ...body } = value;
  if (
    value.packageHash !== packageHash ||
    hashManifest(body) !== attributionHash
  )
    throw Error("Publication attribution integrity failure");
  return value;
}
