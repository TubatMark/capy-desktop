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

/** Picker models offered in Settings. First is the default. */
export const MODELS = [
  { id: "claude-sonnet-5", label: "Sonnet 5 — good judgment, moderate usage" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — cheapest" },
  { id: "claude-opus-5-5", label: "Opus 5.5 — best picks, most usage" },
] as const;

/** App-wide settings stored in <CAPY_DATA_DIR>/settings.json (see server/settings.ts). */
export interface AppSettings {
  /** Browser whose YouTube cookies yt-dlp should use (chrome, safari, …). */
  browser?: string;
  /** Where jobs and rendered clips are written. Applies after relaunch. */
  outputDir?: string;
  /** Default picker model. */
  model?: string;
  /** "subscription" bills the local `claude` login; "apiKey" uses `apiKey`. */
  claudeAuth: "subscription" | "apiKey";
  apiKey?: string;
  /** Unix ms of the last completed setup check. */
  checkedAt?: number;
}

/** One line of the setup check (server/doctor.ts, GET /api/check). */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** A command or sentence that fixes it. */
  fix?: string;
}

/**
 * Who is using the app and what they may do. Today always the local owner;
 * server/access.ts is the one place that changes when sign-in and plans arrive.
 */
export interface Access {
  user: { id: string; name: string };
  plan: "local" | "free" | "pro";
  can: { createJob: boolean; render: boolean };
}
