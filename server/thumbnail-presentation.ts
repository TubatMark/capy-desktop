import { toMediaUrl } from "./paths";
import type {
  ThumbnailStudioDocument,
  FrameCandidate,
} from "../lib/thumbnails";
export function presentThumbnail(doc: ThumbnailStudioDocument) {
  return {
    ...doc,
    versions: doc.versions.map((v) => ({ ...v, path: toMediaUrl(v.path) })),
  };
}
export function presentFrame(frame: FrameCandidate) {
  return { ...frame, path: toMediaUrl(frame.path) };
}
