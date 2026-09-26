import path from "node:path";

/** Everything the app writes lives under this folder (CAPY_OUTPUT overrides). */
export const OUTPUT_ROOT = path.resolve(/*turbopackIgnore: true*/ (process.env.CAPY_OUTPUT ?? process.env.CLIPRUN_OUTPUT) ?? "output");

/** Resolve a media path from the browser, refusing anything outside OUTPUT_ROOT. */
export function safeMediaPath(rel: string): string {
  const abs = path.resolve(OUTPUT_ROOT, rel);
  if (abs !== OUTPUT_ROOT && !abs.startsWith(OUTPUT_ROOT + path.sep)) throw new Error("Path outside output folder");
  return abs;
}

export function toMediaUrl(abs: string): string {
  return `/api/media/${encodeURIComponent(path.relative(OUTPUT_ROOT, abs)).replace(/%2F/g, "/")}`;
}
