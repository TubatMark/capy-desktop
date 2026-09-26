import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OUTPUT_ROOT } from "./paths";
import { AGENT_SPECS } from "../src/agents";
import type { AgentId, AppSettings } from "../lib/types";
import { DEFAULT_APP_SETTINGS } from "../lib/types";

const FILE = path.join(OUTPUT_ROOT, ".settings.json");
let cache: AppSettings | null = null;

export async function loadAppSettings(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(await readFile(FILE, "utf8")));
  } catch {
    cache = { ...DEFAULT_APP_SETTINGS, models: {} };
  }
  return cache;
}

export async function saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const cur = await loadAppSettings();
  const next = sanitize({ ...cur, ...patch, models: { ...cur.models, ...patch.models } });
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

export function isAgentId(v: unknown): v is AgentId {
  return AGENT_SPECS.some((a) => a.id === v);
}

function sanitize(raw: any): AppSettings {
  const models: AppSettings["models"] = {};
  for (const [k, v] of Object.entries(raw?.models ?? {})) {
    if (isAgentId(k) && typeof v === "string" && v.trim()) models[k] = v.trim().slice(0, 200);
  }
  return { agent: isAgentId(raw?.agent) ? raw.agent : DEFAULT_APP_SETTINGS.agent, models };
}
