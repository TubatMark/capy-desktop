import {
  thumbnailProvenanceComplete,
  type ThumbnailDesign,
} from "../lib/thumbnails";
import type { JobState } from "../lib/types";
import type { QueueEntry, QueueThumbnailOption } from "../lib/types";
import type { Store } from "./db";
import { runtimeStore } from "./db/runtime";
import { toMediaUrl } from "./paths";

/** Designs made from this clip's current footage: the original video's thumbnail first, then in the order made. */
export function clipThumbnailDesigns(
  jobId: string,
  n: number,
  store: Store = runtimeStore(),
): ThumbnailDesign[] {
  const job = store.get<JobState>("legacy-jobs", jobId);
  const revision = job?.revision;
  if (revision === undefined) return [];
  return store
    .list<ThumbnailDesign>("thumbnails")
    .map((r) => r.value)
    .filter(
      (d) =>
        d.sourceIdentity.kind === "legacy" &&
        d.sourceIdentity.jobId === jobId &&
        d.sourceIdentity.clipN === n &&
        d.sourceIdentity.revision === revision &&
        d.generationState === "ready" &&
        d.reviewState !== "stale" &&
        d.reviewState !== "blocked" &&
        d.versions.some((v) => v.format === "jpg") &&
        thumbnailProvenanceComplete(d, job?.value.videoId),
    )
    .map((d) => ({
      d,
      rank: [
        d.layout === "original" ? 0 : 1,
        Math.min(...d.versions.map((v) => v.createdAt)),
      ],
    }))
    .sort((a, b) => a.rank[0]! - b.rank[0]! || a.rank[1]! - b.rank[1]!)
    .map(({ d }) => d);
}

const mediaUrl = (file: string) => {
  try {
    return toMediaUrl(file);
  } catch {
    return undefined;
  }
};

/** Queue fields for the designed thumbnail: the exact jpg that will be uploaded, plus the designs to switch to. */
export function queueThumbnailFields(
  e: QueueEntry,
  store: Store = runtimeStore(),
): Pick<
  QueueEntry,
  "thumbnailDesignId" | "thumbnailDesignUrl" | "thumbnailOptions"
> {
  const designId = e.publishPackage?.thumbnail?.designId;
  const attachedFile =
    designId && e.publicationFiles?.thumbFile
      ? mediaUrl(e.publicationFiles.thumbFile)
      : undefined;
  const options =
    e.platform === "youtube" && !e.source && e.jobId && e.n !== undefined
      ? clipThumbnailDesigns(e.jobId, e.n, store).flatMap(
          (d): QueueThumbnailOption[] => {
          const jpg = d.versions.filter((v) => v.format === "jpg").at(-1)!;
          const url = mediaUrl(jpg.path);
          return url
            ? [
                {
                  designId: d.id,
                  url,
                  layout: d.layout,
                  headline: d.layers.find((l) => l.kind === "text")?.text,
                  ...(d.pick ? { pickedBy: d.pick.by } : {}),
                  ...(d.judged?.by === "ai" && d.judged.rank === 1
                    ? { aiChoice: true, ...(d.judged.reason ? { aiReason: d.judged.reason } : {}) }
                    : {}),
                  attached: d.id === designId,
                },
              ]
            : [];
          },
        )
      : [];
  return {
    ...(designId && attachedFile
      ? { thumbnailDesignId: designId, thumbnailDesignUrl: attachedFile }
      : {}),
    ...(options.length ? { thumbnailOptions: options } : {}),
  };
}
