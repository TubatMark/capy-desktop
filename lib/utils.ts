import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 754.2 -> "12:34" */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 754.26 -> "12:34.3" (for the editor) */
export function fmtTimeMs(sec: number): string {
  const base = fmtTime(sec);
  const tenths = Math.floor((sec - Math.floor(sec)) * 10);
  return `${base}.${tenths}`;
}

/** 95 -> "~1m 35s" */
export function fmtRemaining(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "almost done";
  if (sec < 60) return `~${Math.ceil(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `~${m}m ${s}s`;
}

export function ytThumb(videoId: string) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** 95000 -> "1m 35s", 8000 -> "8s" */
export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
