import type { Look } from "./look";
/** Shared between server and browser. No node imports here. */

export type JobStatus = "queued" | "analyzing" | "preparing" | "ready" | "error";
export type Stage = "meta" | "captions" | "pick" | "segments" | "done";

export interface Estimate {
  /** Seconds remaining for the current stage (0 when unknown). */
  stageRemaining: number;
  /** Seconds remaining until picks are ready to review. */
  totalRemaining: number;
  /** Fraction 0..1 through the analyze+prepare flow. */
  progress: number;
}

export interface RenderState {
  status: "none" | "queued" | "rendering" | "done" | "error" | "stale";
  file?: string;
  /** Relative media path for the player. */
  url?: string;
  progress?: number;
  /** Estimated seconds remaining for this render. */
  remaining?: number;
  startedAt?: number;
  tookMs?: number;
  error?: string;
  /** Thumbnail grabbed from the rendered clip (hook visible). */
  thumbUrl?: string;
  /** The .txt with title/description/hashtags next to the mp4. */
  textUrl?: string;
}

/** Seconds into a rendered clip where the hook is still on screen: the default thumbnail frame. */
export const HOOK_FRAME_SEC = 1.4;

export interface ThumbOption {
  url: string;
  /** Seconds into the clip. */
  at: number;
}

export interface ClipState {
  n: number;
  start: number;
  end: number;
  title: string;
  hook: string;
  reason: string;
  score: number;
  selected: boolean;
  /** Padded segment on disk that the editor plays and renders from. */
  segment?: { start: number; end: number; url: string; status: "queued" | "downloading" | "done" | "error"; error?: string; remaining?: number };
  thumbUrl?: string;
  /** Candidate frames for the YouTube thumbnail (from the rendered clip, or the source footage before a render). */
  thumbs?: ThumbOption[];
  /** Seconds into the clip the chosen thumbnail frame is taken from; unset = the default hook frame. */
  thumbAt?: number;
  render: RenderState;
  /** YouTube upload text. Editable; regenerated on demand. */
  publish?: { ytTitle: string; description: string; hashtags: string[] };
}

export interface JobSettings {
  count: number;
  minSec: number;
  maxSec: number;
  focus?: string;
  layout: "center" | "blur";
  style: "bold" | "clean";
  captions: boolean;
  hook: boolean;
  /** Caption/hook styling and colour vibe for every clip of this video; unset = the style's defaults (see lib/look.ts). */
  look?: Look;
  model?: string;
  maxRes: number;
  browser?: string;
  lang?: string;
}

export interface LogLine {
  t: number;
  stage: Stage | "render" | "error" | "done";
  msg: string;
}

export interface JobState {
  id: string;
  videoId: string;
  url: string;
  title?: string;
  channel?: string;
  duration?: number;
  language?: string;
  status: JobStatus;
  stage: Stage;
  stageStartedAt: number;
  createdAt: number;
  /** When the last analyze run started / how long it took to be ready. */
  startedAt?: number;
  tookMs?: number;
  settings: JobSettings;
  estimate: Estimate;
  clips: ClipState[];
  transcriptSource?: "cache" | "captions" | "whisper";
  wordCount?: number;
  pickCostUsd?: number;
  error?: string;
  log: LogLine[];
  /** Folder under output/, relative. */
  dir: string;
}

export interface Word {
  text: string;
  start: number;
  end: number;
}

export const DEFAULT_SETTINGS: JobSettings = {
  count: 6,
  minSec: 20,
  maxSec: 60,
  layout: "center",
  style: "bold",
  captions: true,
  hook: true,
  maxRes: 2160,
};

/** AI coding CLIs capy knows how to drive for picking clips and writing titles. */
export type AgentId = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "droid" | "copilot" | "qwen" | "amp";

export interface AgentInfo {
  id: AgentId;
  name: string;
  vendor: string;
  /** Command to run it; shown as the install check. */
  bin: string;
  installed: boolean;
  /** Absolute path of the binary we found. */
  path?: string;
  version?: string;
  install: string;
  url: string;
  /** Example model id for the model field. */
  modelHint: string;
}

/** App-wide preferences, saved to output/.settings.json. */
export interface AppSettings {
  agent: AgentId;
  /** Model per agent; empty means the CLI's own default. */
  models: Partial<Record<AgentId, string>>;
}

export const DEFAULT_APP_SETTINGS: AppSettings = { agent: "claude", models: {} };
