import { homedir } from "node:os";
import path from "node:path";
import "./boot";
import { effective } from "./settings";

/**
 * Everything the app writes lives under this folder. Resolved once per server start:
 * settings.json `outputDir` → `CAPY_OUTPUT` → (`~/Movies/capy` in the desktop app, `./output` in the browser workflow).
 * The Settings page says a change applies after relaunch.
 */
export const OUTPUT_ROOT = path.resolve(/*turbopackIgnore: true*/ effective().outputDir ?? (process.env.CAPY_DESKTOP === "1" ? path.join(homedir(), "Movies", "capy") : "output"));

/** Resolve a media path from the browser, refusing anything outside OUTPUT_ROOT. */
export function safeMediaPath(rel: string): string {
  const abs = path.resolve(OUTPUT_ROOT, rel);
  if (abs !== OUTPUT_ROOT && !abs.startsWith(OUTPUT_ROOT + path.sep)) throw new Error("Path outside output folder");
  return abs;
}

export function toMediaUrl(abs: string): string {
  return `/api/media/${encodeURIComponent(path.relative(OUTPUT_ROOT, abs)).replace(/%2F/g, "/")}`;
}
