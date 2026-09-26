import { loadDotEnv } from "../src/env";
import { ensureToolPaths } from "../src/exec";
import { applyToEnv } from "./settings";

declare global {
  // eslint-disable-next-line no-var
  var __capyBooted: boolean | undefined;
}

/**
 * One-time server start-up: `.env` (so the browser workflow is unchanged), the tool PATH
 * for Finder-launched apps, and the Claude billing choice from settings.json.
 * Guarded on globalThis so Next.js dev reloads don't re-run it; safe to call anywhere.
 */
export function boot(): void {
  if (globalThis.__capyBooted) return;
  globalThis.__capyBooted = true;
  loadDotEnv();
  ensureToolPaths();
  applyToEnv();
}

boot();
