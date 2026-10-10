import type {
  ProjectDocument,
  RenderArtifact,
  ThumbnailDocument,
} from "./studio/types";
import type { AiCost } from "./ai-policy";
export type ThumbnailAspect = "landscape" | "portrait" | "square";
export const THUMBNAIL_DIMENSIONS: Record<
  ThumbnailAspect,
  { width: number; height: number }
> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};
/** Public requests contain identities only; paths and document snapshots are resolved by the server. */
export type ThumbnailSourceRef =
  | {
      kind: "legacy";
      jobId: string;
      clipN: number;
      revision: number;
      renderChecksum: string;
    }
  | {
      kind: "project";
      projectId: string;
      revision: number;
      renderId: string;
      renderChecksum: string;
    };
/** Trusted extraction input. Finished renders and clean footage both retain their exact edit identity. */
export type ThumbnailSource =
  | {
      kind: "legacy";
      clipId: string;
      revision: number;
      assetId: string;
      path: string;
      checksum: string;
      sourceOffsetUs?: number;
    }
  | {
      kind: "project";
      project: ProjectDocument;
      render: RenderArtifact;
      assets?: {
        id: string;
        path: string;
        checksum: string;
        sourceOffsetUs?: number;
        kind?: "video" | "image";
      }[];
    };
export interface FrameCandidate {
  id: string;
  path: string;
  checksum: string;
  assetId: string;
  sourceUs: number;
  renderUs: number;
  sourceRevision: number;
  renderChecksum: string;
  frameKind: "clean" | "finished";
  quality: {
    status: "usable" | "fallback";
    score: number;
    sharpness: number;
    exposure: number;
    reason?: string;
  };
}
export type ThumbnailLayout = "bold" | "editorial" | "minimal";
/** "original" is built from the source video's own YouTube thumbnail instead of a clip frame. */
export type ThumbnailDesignLayout = ThumbnailLayout | "original";
/** Provenance of an "original" design: the source video's published thumbnail, as fetched and cached. */
export interface SourceThumbnailRef {
  videoId: string;
  url: string;
  checksum: string;
}
export interface ThumbnailBriefInput {
  title?: string;
  headline: string;
  aspect: ThumbnailAspect;
  style?: "bold" | "clean";
  variant: number;
  /** Overrides the variant's default layout (the AI pick puts its chosen layout first). */
  layout?: ThumbnailLayout;
  frames: FrameCandidate[];
}
export interface ThumbnailBrief {
  style?: "bold" | "clean";
  version: 1;
  layout: ThumbnailLayout;
  headline: string;
  aspect: ThumbnailAspect;
  instructions: string;
  sourceFrameIds: string[];
}
export interface ThumbnailLayer {
  /** Reserved source/background IDs identify image roles independently of kind or array order. */
  id: string;
  kind: "image" | "text" | "shape";
  assetId?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Normalized crop in original source pixels, before contain composition. */
  crop?: { x: number; y: number; width: number; height: number };
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  /** Resolved drawtext typography; bounds come from an actual glyph raster. */
  textLayout?: {
    fontFamily: string;
    fontChecksum: string;
    fontSize: number;
    lineAdvance: number;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    lines: { text: string; width: number; y: number }[];
  };
}
export interface ThumbnailVersion {
  id: string;
  checksum: string;
  path: string;
  format: "png" | "jpg";
  width: number;
  height: number;
  createdAt: number;
}
export interface ThumbnailDesign extends Omit<
  ThumbnailDocument,
  "layers" | "versions" | "provenance"
> {
  sourceIdentity: ThumbnailSourceRef;
  name: string;
  layout: ThumbnailDesignLayout;
  /** Set on "original" designs only (their sourceFrames is empty); frame designs never carry it. */
  sourceThumbnail?: SourceThumbnailRef;
  layers: ThumbnailLayer[];
  versions: ThumbnailVersion[];
  provenance: {
    provider: string;
    model: string;
    prompt: string;
    capability: "reference-image-generation" | "local-composition";
    cost?: AiCost;
    usage?: { requests: number; tokens?: number };
  };
  imageGeneration: {
    status: "available" | "unavailable";
    reason?: string;
    accounting: "application-estimates" | "verified-provider-bounds" | "local";
  };
  /** Automatic designs: whether the AI chose the frame/headline or the local ranking did. */
  pick?: { by: "ai" | "heuristic"; reason?: string };
  /** The thumbnail reviewer's verdict across this clip's designs: 1 = the one it judged most effective. */
  judged?: { by: "ai" | "default"; rank: number; reason?: string; at: number };
}
export interface ThumbnailRequest {
  source: ThumbnailSourceRef;
  aspect: ThumbnailAspect;
  headline: string;
  style?: "bold" | "clean";
  /** A manual scrub selection is snapped to a decoded source frame. */
  frameTimeUs?: number;
  frameKind?: "clean" | "finished";
  /** A new explicit ID permits regeneration while duplicate submissions remain idempotent. */
  requestId?: string;
  selectedFrameIds?: string[];
  variantCount?: number;
  action?: "frames" | "generate";
  mode?: "manual" | "automatic";
  allowCloud?: boolean;
  allowLocal?: boolean;
  maxJobUsd?: number;
  maxDayUsd?: number;
  /** What the clip says, for the AI frame/headline pick of automatic requests only. */
  clipContext?: { title?: string; hook?: string; transcript?: string };
}

/**
 * Where a design's picture came from must be on record: frame designs need their clip frames; "original"
 * designs need the source video's own thumbnail (from this clip's source video) and no frames.
 */
export function thumbnailProvenanceComplete(
  design: Pick<ThumbnailDesign, "layout" | "sourceFrames" | "sourceThumbnail">,
  sourceVideoId?: string,
) {
  if (design.layout === "original" || design.sourceThumbnail)
    return (
      design.layout === "original" &&
      !!design.sourceThumbnail &&
      !design.sourceFrames.length &&
      design.sourceThumbnail.videoId === sourceVideoId
    );
  return design.sourceFrames.length > 0;
}

/** editRevision is independent of the exact footage/project revision. */
export interface ThumbnailStudioDocument extends ThumbnailDesign {
  editRevision: number;
}
export interface ThumbnailExportOptions {
  format: "png" | "jpg";
  aspect: ThumbnailAspect;
  text: boolean;
}
export interface ThumbnailExport {
  path: string;
  filename: string;
  checksum: string;
  width: number;
  height: number;
  layers: ThumbnailLayer[];
}
export interface ThumbnailReviewAudit {
  thumbnailId: string;
  editRevision: number;
  digest: string;
  state: "approved";
  at: number;
  sourceIdentity: ThumbnailSourceRef;
  versionChecksums: { id: string; checksum: string }[];
}
/** Shared pure manifest permits the central publication gate to verify the exact review audit. */
export function thumbnailReviewManifest(doc: ThumbnailStudioDocument) {
  return {
    id: doc.id,
    editRevision: doc.editRevision,
    sourceIdentity: doc.sourceIdentity,
    renderChecksum: doc.renderChecksum,
    sourceFrames: doc.sourceFrames,
    ...(doc.sourceThumbnail ? { sourceThumbnail: doc.sourceThumbnail } : {}),
    layout: doc.layout,
    aspectPreset: doc.aspectPreset,
    layers: doc.layers,
    versions: doc.versions,
    provenance: doc.provenance,
  };
}
