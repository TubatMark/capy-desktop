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
export interface ThumbnailBriefInput {
  title?: string;
  headline: string;
  aspect: ThumbnailAspect;
  style?: "bold" | "clean";
  variant: number;
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
  id: string;
  kind: "image" | "text" | "shape";
  assetId?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
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
  layout: ThumbnailLayout;
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
}
