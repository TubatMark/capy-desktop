import {
  AutomationControlsSchema,
  CreatorPoliciesSchema,
  DEFAULT_CONTROLS,
} from "../lib/creator-policy";
import {
  AiRoutingSchema,
  DEFAULT_AI_ROUTING,
  DISABLED_AI_ROUTING,
} from "../lib/ai-policy";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  AGENT_IDS,
  DEFAULT_APP_SETTINGS,
  MODELS,
  type AgentId,
  type AppSettings,
  type Audience,
} from "../lib/types";

/**
 * App-wide settings in <CAPY_DATA_DIR>/settings.json. This module is the only reader/writer.
 *
 * Precedence, lowest to highest: built-in default → environment (`CAPY_*`, `.env`) →
 * settings.json → per-job settings (applied by the job manager, not here).
 */

export const DEFAULT_SETTINGS: AppSettings = DEFAULT_APP_SETTINGS;

export function isAgentId(v: unknown): v is AgentId {
  return (AGENT_IDS as readonly string[]).includes(v as string);
}

/** Browsers yt-dlp can read cookies from (`--cookies-from-browser`). */
export const BROWSERS = [
  "chrome",
  "safari",
  "firefox",
  "brave",
  "edge",
  "arc",
] as const;

/** Where the app keeps its own files (settings.json). Electron passes app.getPath("userData"), which is the same folder. */
export function dataDir(): string {
  return expandHome(
    process.env.CAPY_DATA_DIR?.trim() ||
      path.join(homedir(), "Library", "Application Support", "capy"),
  );
}

export function settingsFile(): string {
  return path.join(dataDir(), "settings.json");
}

/** `~` and `~/x` → absolute. Anything else is returned untouched. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Module state lives on globalThis: Next.js compiles pages and route handlers as separate module
 * graphs (and dev reloads re-evaluate modules), so a plain module variable would give each of them
 * its own stale copy. The cache is also validated against the file's mtime, so a write from any
 * instance — or a hand edit — is picked up on the next read.
 */
interface State {
  cache: { file: string; mtime: number; raw: Partial<AppSettings> } | null;
  /** The key that was in the environment before we touched it; `null` = not captured yet. */
  originalEnvKey: string | undefined | null;
}
declare global {
  // eslint-disable-next-line no-var
  var __capySettings: State | undefined;
}
const state: State = (globalThis.__capySettings ??= {
  cache: null,
  originalEnvKey: null,
});

/** Drop the in-memory copy so the next read hits the disk (tests, and after CAPY_DATA_DIR changes). */
export function resetSettingsCache() {
  state.cache = null;
  state.originalEnvKey = null;
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1; // missing
  }
}

/** What is literally in the file (no defaults), so we can tell "unset" from "set to the default". */
function raw(): Partial<AppSettings> {
  const file = settingsFile();
  const mtime = mtimeOf(file);
  const c = state.cache;
  if (c && c.file === file && c.mtime === mtime) return c.raw;
  let parsed: Partial<AppSettings> = {};
  if (mtime >= 0) {
    try {
      const obj = JSON.parse(readFileSync(file, "utf8"));
      if (obj && typeof obj === "object" && !Array.isArray(obj))
        parsed = clean(obj as Record<string, unknown>, false);
      else throw new Error("Settings must be an object");
    } catch {
      parsed = {
        aiRouting: DISABLED_AI_ROUTING,
        aiRoutingError:
          "Settings file is unreadable. AI calls are disabled until valid routing is saved.",
      };
    }
  }
  state.cache = { file, mtime, raw: parsed };
  return parsed;
}

/** Keep only known keys with sane types. */
function clean(
  obj: Record<string, unknown>,
  strictRouting = true,
): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  for (const [key, schema] of [
    ["automationControls", AutomationControlsSchema],
    ["creatorPolicies", CreatorPoliciesSchema],
  ] as const) {
    if (!Object.hasOwn(obj, key)) continue;
    const parsed = schema.safeParse(obj[key]);
    if (!parsed.success) {
      if (strictRouting) throw parsed.error;
      out.automationControls = { ...DEFAULT_CONTROLS, globalStop: true };
      continue;
    }
    if (key === "automationControls")
      out.automationControls = AutomationControlsSchema.parse(parsed.data);
    else {
      const policies = CreatorPoliciesSchema.parse(parsed.data);
      // No imported/saved setting can activate unattended publication before release proof.
      if (Object.values(policies).some((p) => p.mode === "automatic_publish")) {
        if (strictRouting)
          throw Error(
            "Automatic publication requires a real 72-hour soak and separately authorized upload",
          );
        for (const p of Object.values(policies))
          if (p.mode === "automatic_publish") p.mode = "automatic_drafts";
      }
      out.creatorPolicies = policies;
    }
  }
  if (Object.hasOwn(obj, "aiRouting")) {
    const routing = AiRoutingSchema.safeParse(obj.aiRouting);
    if (routing.success) out.aiRouting = routing.data;
    else if (strictRouting) throw routing.error;
    else {
      out.aiRouting = DISABLED_AI_ROUTING;
      const issue = routing.error.issues[0];
      out.aiRoutingError = `Invalid saved AI routing (${issue?.path.join(".") ?? "policy"}). AI calls are disabled; save a valid policy to repair it.`;
    }
  }
  if (typeof obj.browser === "string" && obj.browser) out.browser = obj.browser;
  if (typeof obj.outputDir === "string" && obj.outputDir)
    out.outputDir = obj.outputDir;
  if (isAgentId(obj.agent)) out.agent = obj.agent;
  const models: AppSettings["models"] = {};
  if (obj.models && typeof obj.models === "object") {
    for (const [k, v] of Object.entries(
      obj.models as Record<string, unknown>,
    )) {
      if (isAgentId(k) && typeof v === "string" && v.trim())
        models[k] = v.trim().slice(0, 200);
    }
  }
  // older files stored a single Claude model
  if (!models.claude && typeof obj.model === "string" && obj.model)
    models.claude = obj.model;
  if (Object.keys(models).length) out.models = models;
  if (obj.claudeAuth === "subscription" || obj.claudeAuth === "apiKey")
    out.claudeAuth = obj.claudeAuth;
  if (typeof obj.apiKey === "string" && obj.apiKey) out.apiKey = obj.apiKey;
  if (typeof obj.checkedAt === "number" && Number.isFinite(obj.checkedAt))
    out.checkedAt = obj.checkedAt;
  if (obj.audience === "original" || obj.audience === "en-us")
    out.audience = obj.audience;
  if (typeof obj.postingAudience === "string" && obj.postingAudience)
    out.postingAudience = obj.postingAudience;
  if (typeof obj.postingPaused === "boolean")
    out.postingPaused = obj.postingPaused;
  if (typeof obj.autoSchedule === "boolean")
    out.autoSchedule = obj.autoSchedule;
  return out;
}

/** Settings as stored, with defaults filled in. Sync and cached; a missing file yields the defaults. */
export function loadSettings(): AppSettings {
  const r = raw();
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    models: { ...r.models },
    aiRouting: r.aiRouting ?? DEFAULT_AI_ROUTING,
  };
}

/** Async aliases for callers that predate the sync API. */
export async function loadAppSettings(): Promise<AppSettings> {
  return loadSettings();
}
export async function saveAppSettings(
  patch: SettingsPatch,
): Promise<AppSettings> {
  return saveSettings(patch);
}

/** A partial update; `""` or `null` on any key removes it from the file. */
export type SettingsPatch = {
  [K in Exclude<keyof AppSettings, "models">]?: AppSettings[K] | "" | null;
} & {
  models?: Partial<Record<AgentId, string | "" | null>>;
};

/**
 * Merge `patch` into the file. An empty string (or null) deletes that key. The file is written
 * with mode 0600 because it may hold an API key. Returns the new settings (unredacted).
 */
export function saveSettings(patch: SettingsPatch): AppSettings {
  const next: Record<string, unknown> = { ...raw() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "models" && v && typeof v === "object") {
      // per-agent merge; an empty string drops that agent's model
      const merged: Record<string, string> = {
        ...((next.models as Record<string, string> | undefined) ?? {}),
      };
      for (const [id, m] of Object.entries(
        v as Record<string, string | "" | null | undefined>,
      )) {
        if (m === undefined) continue;
        if (m === "" || m === null) delete merged[id];
        else merged[id] = m;
      }
      next.models = merged;
      continue;
    }
    if (v === "" || v === null) delete next[k];
    else next[k] = v;
  }
  const cleaned = clean(next);
  const file = settingsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cleaned, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  state.cache = { file, mtime: mtimeOf(file), raw: cleaned };
  applyToEnv();
  return loadSettings();
}

/** Safe to send to the browser: the API key becomes "••••" + its last 4 characters. */
export function redact(s: AppSettings): AppSettings {
  const { apiKey, ...rest } = s;
  return apiKey ? { ...rest, apiKey: `••••${apiKey.slice(-4)}` } : rest;
}

export interface EffectiveSettings {
  agent: AgentId;
  /** Model per agent as stored; `model` below is the resolved Claude model. */
  models: AppSettings["models"];
  browser?: string;
  outputDir?: string;
  /** The Claude model: settings → CAPY_MODEL → the first of MODELS. */
  model: string;
  claudeAuth: AppSettings["claudeAuth"];
  apiKey?: string;
  /** Default audience for new videos. */
  audience: Audience;
  /** AUDIENCES id whose time zone posting slots use. */
  postingAudience: string;
  postingPaused: boolean;
  autoSchedule: boolean;
}

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** Resolved values: default → env (`CAPY_BROWSER`, `CAPY_OUTPUT`, `CAPY_MODEL`, `CAPY_USE_API_KEY`) → settings.json. */
export function effective(): EffectiveSettings {
  const s = raw();
  const outputDir = s.outputDir ?? env("CAPY_OUTPUT", "CLIPRUN_OUTPUT");
  const agentEnv = env("CAPY_AGENT");
  return {
    agent: s.agent ?? (isAgentId(agentEnv) ? agentEnv : "claude"),
    models: { ...s.models },
    browser: s.browser ?? env("CAPY_BROWSER", "CLIPRUN_BROWSER"),
    outputDir: outputDir ? expandHome(outputDir) : undefined,
    model:
      s.models?.claude ?? env("CAPY_MODEL", "CLIPRUN_MODEL") ?? MODELS[0].id,
    claudeAuth:
      s.claudeAuth ??
      (env("CAPY_USE_API_KEY", "CLIPRUN_USE_API_KEY")
        ? "apiKey"
        : "subscription"),
    apiKey: s.apiKey ?? envApiKey(),
    audience: s.audience ?? "en-us",
    postingAudience: s.postingAudience ?? "us-east",
    postingPaused: s.postingPaused ?? false,
    autoSchedule: s.autoSchedule ?? true,
  };
}

/** The key from the environment, not one we put there from settings.json. */
function envApiKey(): string | undefined {
  return (
    (state.originalEnvKey === null
      ? process.env.ANTHROPIC_API_KEY
      : state.originalEnvKey) || undefined
  );
}

/**
 * Make `src/pick.ts` honour the billing choice: `apiKey` mode sets `CAPY_USE_API_KEY=1` and
 * `ANTHROPIC_API_KEY`; `subscription` mode unsets `CAPY_USE_API_KEY` so the SDK subprocess
 * drops any key and bills the local `claude` login. Call at startup and after every save.
 */
export function applyToEnv(): void {
  if (state.originalEnvKey === null)
    state.originalEnvKey = process.env.ANTHROPIC_API_KEY;
  const e = effective();
  if (e.claudeAuth === "apiKey" && e.apiKey) {
    process.env.CAPY_USE_API_KEY = "1";
    process.env.ANTHROPIC_API_KEY = e.apiKey;
  } else {
    delete process.env.CAPY_USE_API_KEY;
    if (state.originalEnvKey)
      process.env.ANTHROPIC_API_KEY = state.originalEnvKey;
    else delete process.env.ANTHROPIC_API_KEY;
  }
}
