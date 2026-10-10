import type { PublishPackage, PublicationDecision } from "./publication";
import type { AiRoutingSettings } from "./ai-policy";
import type { Look } from "./look";
/** Shared between server and browser. No node imports here. */

/** Who the clips are for: "en-us" writes text in US English and translates captions of non-English videos. */
export type Audience = "original" | "en-us";

/** Where capy can post a rendered clip. */
export type Platform = "youtube" | "instagram" | "tiktok";
export const PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];

export type QueueStatus =
  | "review"
  | "scheduled"
  | "posting"
  | "posted"
  | "needs_action"
  | "failed"
  | "rejected";

/** Text sent with a post; YouTube uses title/description/tags, Instagram and TikTok use caption. */
export interface PostText {
  title?: string;
  description?: string;
  tags?: string[];
  caption?: string;
}

/** One clip going to one platform (server/queue.ts owns these). */
/** One designed thumbnail the Queue can switch a post to; `url` previews its latest jpg. */
export interface QueueThumbnailOption {
  designId: string;
  url: string;
  layout: "bold" | "editorial" | "minimal";
  headline?: string;
  /** "ai" when the AI chose its frame and headline. */
  pickedBy?: "ai" | "heuristic";
  attached: boolean;
}

export interface QueueEntry {
  remoteSchedule?: {
    publishAt: number;
    uploadAheadMinutes: number;
    schedulePolicy: "youtube-schedule-v1";
  };
  delivery?: import("./delivery").DeliveryAttributionProjection;
  deliveryCanRetry?: boolean;
  source?: {
    kind: "studio";
    projectId: string;
    revision: number;
    renderId: string;
    renderChecksum: string;
  };
  publishPackage?: PublishPackage;
  publicationDecision?: PublicationDecision;
  /** Server-resolved media locations; never derive content identity from URLs. */
  publicationFiles?: { file: string; thumbFile?: string };
  /** `${jobId}:${n}:${platform}` */
  key: string;
  jobId?: string;
  n?: number;
  platform: Platform;
  status: QueueStatus;
  clipTitle: string;
  /** Which cut of clip n this is ("start-end" in tenths of a second): a re-cut clip needs a fresh review. */
  fp?: string;
  /** Upload progress kept across retries so a retry never uploads twice. */
  progress?: Record<string, string>;
  /** The AI content reviewer's verdict on this clip. */
  aiReview?: ContentReview;
  /** A kids' story: YouTube marks it "made for kids". */
  madeForKids?: boolean;
  /** Where the review card's title links (default: the clip page). */
  link?: string;
  /** The SEO score of the text it posts with. */
  seo?: SeoReport;
  videoTitle?: string;
  videoUrl?: string;
  /** The picture to show for this post: the attached designed thumbnail when there is one, else the raw frame. */
  thumbUrl?: string;
  /** The raw frame grab (publicQueueEntry only; set when thumbUrl shows a design instead). */
  frameThumbUrl?: string;
  /** The design attached to this post (publicQueueEntry only). */
  thumbnailDesignId?: string;
  /** The exact designed jpg that will be uploaded with the video (publicQueueEntry only). */
  thumbnailDesignUrl?: string;
  /** This clip's designs to switch between (YouTube posts; publicQueueEntry only). */
  thumbnailOptions?: QueueThumbnailOption[];
  thumbAt?: number;
  /** Unix ms. */
  slotAt?: number;
  text: PostText;
  attempts: number;
  nextTryAt?: number;
  /** Waiting on a reconnect of this platform's account. */
  authBlocked?: boolean;
  result?: { id?: string; url?: string; note?: string };
  error?: string;
  history: { t: number; msg: string }[];
  createdAt: number;
  updatedAt: number;
}

/** Source reading consent and publishing destinations are independent principals. */
export type AccountRole = "reading" | "publishing";

export interface SubscriptionChannel {
  id: string;
  name: string;
  thumbnail?: string;
}
export interface SubscriptionPage {
  accountId: string;
  channels: SubscriptionChannel[];
  nextCursor?: string;
}
export interface CreatorImport {
  accountId: string;
  selectedIds: string[];
  backfill: boolean;
  mode: "manual" | "automatic_drafts";
}
export interface ImportCreatorsResult {
  imported: WatchedChannel[];
  existing: string[];
}

/** A platform account as the browser sees it (no tokens, secret redacted). */
export interface AccountPublic {
  capabilities?: import("../server/platform-capabilities").DestinationCapabilities;
  connectedAt?: number;
  role?: AccountRole;
  platform: Platform;
  configured: boolean;
  connected: boolean;
  needsReconnect?: boolean;
  account?: { id: string; name: string; avatar?: string };
  autoPost: boolean;
  /** TikTok: send to inbox (works before the audit) or post directly. */
  mode?: "inbox" | "direct";
  clientId?: string;
  /** "••••abcd" */
  clientSecret?: string;
  /** Instagram: business accounts to pick from when more than one Page has one. */
  choices?: { id: string; name: string }[];
  igUserId?: string;
}

export interface QueueSummary {
  review: number;
  nextPost?: { at: number; platforms: Platform[] };
  /** scheduled + posting */
  activeCount: number;
}

/** A YouTube creator capy watches for new uploads (server/watch.ts owns these). */
export interface WatchedChannel {
  discoveryStatus?: {
    lastSuccessAt?: number;
    nextAttemptAt?: number;
    deferred: number;
    excluded: number;
    method: "uploads-playlist" | "videos-tab";
  };
  /** Only publication times strictly after this Unix-ms cutoff may be discovered; explicit pending backfill is exempt. */
  discoveryAfter?: number;
  sourceAccountId?: string;
  thumbnail?: string;
  mode?: "manual" | "automatic_drafts";
  id: string;
  name: string;
  handle?: string;
  /** The uploads tab. */
  url: string;
  enabled: boolean;
  addedAt: number;
  lastCheckedAt?: number;
  lastError?: string;
  /** Upload ids already handled or deliberately skipped (newest kept). */
  seen: string[];
  /** New uploads waiting for room under the daily caps, oldest first. */
  pending: { id: string; title: string; duration?: number; foundAt: number }[];
  /** Videos sent through the pipeline, newest first. */
  history: {
    videoId: string;
    title: string;
    at: number;
    jobId: string;
    status: "processing" | "rendered" | "error";
    error?: string;
    note?: string;
  }[];
  settings: {
    clips: number;
    minVideoSec: number;
    perDay: number;
    audience?: Audience;
  };
}

export interface WatchFile {
  channels: WatchedChannel[];
  /** Most new videos processed per day across all channels. */
  maxPerDay: number;
  /** Minutes between checks. */
  intervalMin: number;
  lastCheckAt?: number;
}

/** The AI content reviewer's verdict on a rendered clip, before the user's own review. */
export interface ContentReview {
  verdict: "ok" | "caution" | "block";
  summary: string;
  issues: { kind: string; note: string }[];
  /** A better YouTube title, when the reviewer has one. */
  title?: string;
  at: number;
}

// ---------- YouTube SEO and the user's channel ----------

/** Upload text as SEO sees it. */
export interface SeoText {
  title: string;
  description: string;
  hashtags: string[];
  /** Search tags (YouTube's hidden tags), separate from hashtags. */
  tags: string[];
}
export interface SeoCheck {
  id: string;
  label: string;
  weight: number;
  pass: boolean;
  /** What to change, when the check fails. */
  tip?: string;
}
export interface SeoReport {
  /** 0–100. */
  score: number;
  /** The score of the text before capy tuned it. */
  before?: number;
  keyword?: string;
  checks: SeoCheck[];
  /** Why SEO couldn't run, or what limited it (e.g. search quota). */
  note?: string;
  at: number;
}
export interface Keyword {
  term: string;
  /** Historical derived results only; never displayed or consumed. */
  score?: number;
  sources: ("autocomplete" | "ranking" | "yours")[];
  /** Views this search brought the channel (last 28 days). */
  views?: number;
}
/** A video that ranks for a search. */
export interface RankVideo {
  id: string;
  title: string;
  channel: string;
  views?: number;
  publishedAt?: number;
  tags?: string[];
  thumb?: string;
}
export interface KeywordResearch {
  /** Unscored provider results; older derived research is not reusable. */
  rawVersion?: 1;
  yours?: { term: string; views?: number }[];
  seed: string;
  keywords: Keyword[];
  ranking: RankVideo[];
  tags: string[];
  /** Sources that were skipped, and why. */
  notes: string[];
  at: number;
}

/** "Improve" on one of the channel's videos: the current text next to a search-tuned rewrite. */
export interface VideoSeoSuggestion {
  videoId: string;
  keyword?: string;
  current: SeoText;
  suggested: SeoText;
  before: SeoReport;
  after: SeoReport;
  research?: KeywordResearch;
}

export interface ChannelInfo {
  id: string;
  title: string;
  handle?: string;
  description: string;
  avatar?: string;
  subscribers?: number;
  views?: number;
  videos?: number;
  uploads?: string;
  keywords: string[];
}
export interface ChannelVideo {
  id: string;
  title: string;
  description: string;
  tags: string[];
  publishedAt: number;
  categoryId?: string;
  thumb?: string;
  /** Seconds. */
  duration: number;
  views?: number;
  likes?: number;
  comments?: number;
  privacy?: string;
  madeForKids?: boolean;
  /** From Analytics (last 28 days). */
  minutes?: number;
  avgViewPct?: number;
  /** Deterministic SEO score of its current text. */
  seo?: number;
}
export interface ChannelSnapshot {
  channel: ChannelInfo;
  videos: ChannelVideo[];
  /** Last 28 days; missing without the Analytics permission. */
  analytics?: {
    days: {
      day: string;
      views: number;
      minutes: number;
      subsGained: number;
      subsLost: number;
    }[];
    sources: { source: string; views: number }[];
    searches: { term: string; views: number }[];
    avgViewPct?: number;
  };
  /** What couldn't be loaded, in plain words. */
  notes: string[];
  fetchedAt: number;
}

// ---------- original kids stories ----------

export type AgeBand = "2-4" | "5-8";

/** A recurring character, drawn once as an SVG sprite (400×400 box, feet at 200,390) and reused on every page. */
export interface StoryCharacter {
  id: string;
  name: string;
  description: string;
  svg?: string;
  status: "drawing" | "ready" | "error";
  error?: string;
  /** PNG preview. */
  imageUrl?: string;
}

/** A series bible: who the stories are for, how they look, and the cast. */
export interface StorySeries {
  id: string;
  title: string;
  ageBand: AgeBand;
  /** e.g. "gentle and funny, bedtime-calm endings" */
  tone: string;
  /** e.g. "sharing", "trying new things" */
  values: string[];
  /** Palette and drawing style every page follows. */
  artStyle: string;
  characters: StoryCharacter[];
  createdAt: number;
  updatedAt: number;
}

export interface StoryCast {
  id: string;
  /** 0..1 across the page. */
  x: number;
  y?: number;
  scale?: number;
  flip?: boolean;
}

export interface StoryPage {
  text: string;
  /** What the picture shows (the illustrator draws the background from it). */
  scene: string;
  cast: StoryCast[];
  mood?: string;
  status?: "pending" | "drawing" | "ready" | "error";
  imageUrl?: string;
  error?: string;
}

export interface StoryReview {
  verdict: "ok" | "fix" | "block";
  notes: string[];
}

export type StoryStatus =
  | "planning"
  | "writing"
  | "script"
  | "illustrating"
  | "pages"
  | "rendering"
  | "done"
  | "error";

/** Planned at the brief, before a word is written: what parents search, the hook, the shape of the story. */
export interface StoryPlan {
  /** The one search phrase the story should rank for. */
  keyword: string;
  searchTerms: string[];
  /** Searchable, warm, for parents. */
  title: string;
  /** Page 1: the opening line and its picture (also the cover). */
  hook: { line: string; picture: string };
  beats: { setup: string; problem: string; turn: string; ending: string };
  /** A repeated line little ones join in on. */
  refrain?: string;
  pages: number;
  targetSeconds: number;
  /** Why a parent would pick it and play it again. */
  parentsWhy: string;
  /** What limited the research (e.g. search quota). */
  notes?: string[];
  at: number;
}

/** The assessor's look at a story before it reaches the user: one per stage. */
export interface StoryAssessment {
  stage: "script" | "video";
  at: number;
  /** 0–100 each. */
  overall: number;
  scores: {
    hook: number;
    retention: number;
    search: number;
    safety: number;
    production: number;
  };
  verdict: "ready" | "fix" | "block";
  strengths: string[];
  fixes: { area: string; note: string }[];
  /** The assessor couldn't run; the scores are meaningless. */
  error?: string;
}

/** Something waiting for the user, derived from the stories and the queue. */
export interface TodoTask {
  id: string;
  kind: "script" | "pictures" | "video" | "send" | "fix" | "queue" | "error";
  title: string;
  detail?: string;
  href: string;
  tone: "action" | "warn" | "block";
  /** For gauges on the card. */
  overall?: number;
  at: number;
}

export interface StoryState {
  id: string;
  seriesId: string;
  title: string;
  brief: string;
  moral: string;
  status: StoryStatus;
  pages: StoryPage[];
  /** The kid-safety story reviewer's verdict on the script. */
  review?: StoryReview;
  voice?: string;
  video?: {
    url: string;
    file: string;
    duration: number;
    coverUrl?: string;
    renderedAt?: number;
  };
  /** The AI content reviewer on the finished video (kids profile). */
  contentReview?: ContentReview;
  /** Upload text, written for parents. */
  publish?: {
    ytTitle: string;
    description: string;
    hashtags: string[];
    tags?: string[];
    /** The user edited it: SEO scores it but never rewrites it. */ edited?: boolean;
  };
  seo?: SeoReport;
  plan?: StoryPlan;
  assessments?: { script?: StoryAssessment; video?: StoryAssessment };
  /** The assessor is looking at this stage now. */
  assessing?: "script" | "video";
  /** Sent to the posting queue's review list. */
  queuedAt?: number;
  error?: string;
  log: { t: number; msg: string }[];
  createdAt: number;
  updatedAt: number;
}

export type JobStatus =
  "queued" | "analyzing" | "preparing" | "ready" | "error";
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
  segment?: {
    start: number;
    end: number;
    url: string;
    status: "queued" | "downloading" | "done" | "error";
    error?: string;
    remaining?: number;
  };
  thumbUrl?: string;
  /** Candidate frames for the YouTube thumbnail (from the rendered clip, or the source footage before a render). */
  thumbs?: ThumbOption[];
  /** Seconds into the clip the chosen thumbnail frame is taken from; unset = the default hook frame. */
  thumbAt?: number;
  render: RenderState;
  /** YouTube upload text. Editable; regenerated on demand. */
  publish?: {
    ytTitle: string;
    description: string;
    hashtags: string[];
    tags?: string[];
    /** The user edited it: SEO scores it but never rewrites it. */ edited?: boolean;
  };
  seo?: SeoReport;
  /** The independent reviewer's verdict on this pick. */
  review?: ClipReview;
  /** Highest "Most replayed" value overlapping the clip, 0..1. */
  replayPeak?: number;
  /** English captions ready (true), or the translation failed ("error"); unset when not needed. */
  captionsTranslated?: boolean | "error";
  /** The AI content reviewer's verdict on the rendered clip. */
  contentReview?: ContentReview;
}

export type ReviewVerdict = "pass" | "fix_hook" | "fail" | "needs_review";
export interface ClipReview {
  verdict: ReviewVerdict;
  problem?: string;
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
  /** Who the clips are for; unset at create time = the app default (Settings). */
  audience?: Audience; /** Queue rendered clips for review before posting (default true). */
  autoPost?: boolean;
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
  /** Spoken language (meta, else the caption track used); undefined = unknown, treated as English. */
  sourceLang?: string;
  /** Source-video ranges whose captions are translated into words.en.json. */
  translated?: { start: number; end: number }[];
  /** Started by creator automation: render the picks on its own once they're ready. */
  automation?: { channelId: string; channelName: string; recipeId?: string };
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
export const AGENT_IDS = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "droid",
  "copilot",
  "qwen",
  "amp",
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

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

/** Picker models offered in Settings. First is the default. */
export const MODELS = [
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5 — mid-tier candidate, quality unverified",
  },
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5 — compact candidate, quality unverified",
  },
  { id: "claude-opus-5-5", label: "Opus 5.5 — best picks, most usage" },
] as const;

/** App-wide settings stored in <CAPY_DATA_DIR>/settings.json (see server/settings.ts). */
export interface AppSettings {
  creatorPolicies?: Record<string, import("./creator-policy").CreatorPolicy>;
  automationControls?: import("./creator-policy").AutomationControls;
  aiRouting?: AiRoutingSettings;
  /** Present invalid privacy/budget policy disables AI until repaired. Never persisted as policy. */
  aiRoutingError?: string;
  /** The AI that picks clips and writes titles, hooks and descriptions. */
  agent: AgentId;
  /** Model per agent; empty means the agent's own default (Claude: the first of MODELS). */
  models: Partial<Record<AgentId, string>>;
  /** Browser whose YouTube cookies yt-dlp should use (chrome, safari, …). */
  browser?: string;
  /** Where jobs and rendered clips are written. Applies after relaunch. */
  outputDir?: string;
  /** "subscription" bills the local `claude` login; "apiKey" uses `apiKey`. */
  claudeAuth: "subscription" | "apiKey";
  apiKey?: string;
  /** Unix ms of the last completed setup check. */
  checkedAt?: number;
  /** Default audience for new videos (en-us unless set). */
  audience?: Audience; /** Audience time zone for posting slots (an AUDIENCES id from lib/post-time.ts, default us-east). */
  postingAudience?: string;
  /** Stop the poster without touching the queue. */
  postingPaused?: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  agent: "claude",
  models: {},
  claudeAuth: "subscription",
};

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
