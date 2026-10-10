import type { ThumbnailDesign } from "../lib/thumbnails";
import type { QueueEntry, QueueThumbnailOption } from "../lib/types";
import type { Store } from "./db";
import { runtimeStore } from "./db/runtime";
import { toMediaUrl } from "./paths";

/** Designs made from this clip's current footage, in the order they were made (the top pick first). */
export function clipThumbnailDesigns(
  jobId: string,
  n: number,
  store: Store = runtimeStore(),
): ThumbnailDesign[] {
  const revision = store.get("legacy-jobs", jobId)?.revision;
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
        d.versions.some((v) => v.format === "jpg"),
    );
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
