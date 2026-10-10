/** Client-safe durable Studio contracts. Timeline units are frames; source units are microseconds. */
export interface AssetRef {
  id: string;
  kind: "video" | "audio" | "image" | "font";
  checksum: string;
  location: string;
  durationUs?: number;
  streams?: {
    kind: "video" | "audio";
    codec: string;
    width?: number;
    height?: number;
    sampleRate?: number;
  }[];
  original?: { jobId?: string; videoId?: string; sourceOffsetUs?: number };
  status: "probing" | "waiting" | "ready" | "missing" | "relink" | "failed";
  name?: string;
  mediaUrl?: string;
  proxyLocation?: string;
  proxyUrl?: string;
  error?: string;
  workId?: string;
  request?: { jobId: string; videoId: string; startUs: number; endUs: number };
}
/** JSON-safe exact microseconds; numerator and denominator are decimal BigInt strings. */
export interface ExactUs {
  numerator: string;
  denominator: string;
}
export type AudioRole = "dialogue" | "music" | "sfx" | "voiceover";
export interface DuckingSettings {
  enabled: boolean;
  reductionDb: number;
  attackMs: number;
  releaseMs: number;
}
export interface SourceWords {
  assetId: string;
  words: { id: string; startUs: number; endUs: number; text: string }[];
}
export interface CaptionCue {
  id: string;
  startFrame: number;
  durationFrames: number;
  text: string;
  x?: number;
  y?: number;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  source?: {
    itemId: string;
    assetId: string;
    wordId: string;
    startUs: number;
    endUs: number;
  };
  // Manual timing is relative to the mapped source word, so it follows edits.
  offsetFrames?: number;
  manualDurationFrames?: number;
  edited?: boolean;
}
export interface StudioTrack {
  id: string;
  kind: "video" | "audio" | "text";
  role?: "main" | "overlay" | AudioRole;
  muted?: boolean;
  solo?: boolean;
}
export interface TimelineItem {
  id: string;
  trackId: string;
  assetId?: string;
  startFrame: number;
  durationFrames: number;
  sourceInUs?: number;
  sourceOutUs?: number;
  speed: 1;
  transform?: { x: number; y: number; scale: number; rotation: number };
  gain?: number;
  audioRole?: AudioRole;
  muted?: boolean;
  solo?: boolean;
  loop?: boolean;
  loopOffsetUs?: number;
  /** Exact sub-microsecond start, or loop phase, added to sourceInUs. */
  sourcePhaseUs?: ExactUs;
  /** Source extent retained when a non-loop duration is shortened. */
  sourceAvailableOutUs?: number;
  ducking?: DuckingSettings;
  detachedAudioId?: string;
  linkedVideoId?: string;
  transitionOut?: { kind: "crossfade"; durationFrames: number };
  fit?: "contain" | "cover";
  opacity?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  text?: {
    value: string;
    fontAssetId?: string;
    fontSize: number;
    color: string;
  };
}
export interface ProjectDocument {
  schemaVersion: number;
  id: string;
  revision: number;
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  canvas: { width: number; height: number };
  fps: { numerator: number; denominator: number };
  tracks: StudioTrack[];
  items: TimelineItem[];
  sourceMappings: {
    itemId: string;
    assetId: string;
    sourceInUs: number;
    sourceOutUs: number;
  }[];
  captionCues: CaptionCue[];
  sourceWords?: SourceWords[];
  safeArea?: { enabled: boolean; inset: number };
  thumbnailIds: string[];
}
export interface RenderArtifact {
  id: string;
  projectId: string;
  revision: number;
  checksum: string;
  path: string;
  probe: {
    durationUs: number;
    width: number;
    height: number;
    fps: { numerator: number; denominator: number };
    hasAudio: boolean;
  };
  renderer: string;
  rendererVersion: string;
  reviewIds: string[];
}
export interface ThumbnailDocument {
  id: string;
  projectId?: string;
  revision?: number;
  legacyClipId?: string;
  renderChecksum?: string;
  sourceFrames: { assetId: string; sourceUs: number; checksum: string }[];
  aspectPreset: "landscape" | "portrait" | "square";
  layers: {
    id: string;
    kind: "image" | "text";
    assetId?: string;
    text?: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
  versions: { id: string; checksum: string; path: string }[];
  provenance?: { provider: string; model: string; prompt: string };
  generationState: "draft" | "generating" | "ready" | "failed";
  reviewState: "pending" | "approved" | "blocked" | "stale";
}
export interface JobRecord {
  id: string;
  kind: string;
  workKey: string;
  inputRevision: number;
  payload: Record<string, unknown>;
  stage: string;
  status:
    | "queued"
    | "running"
    | "complete"
    | "retryable"
    | "needs_action"
    | "blocked"
    | "cancelled";
  checkpoint: Record<string, unknown>;
  owner?: string;
  generation: number;
  expiresAt: number;
  attempts: number;
  retryAt?: number;
  cancelRequested: boolean;
  error?: string;
  createdAt: number;
  groups: { pid: number; token: string; identity: string }[];
}

export type { AiTaskPolicy, AiRunRecord } from "../ai-policy";
