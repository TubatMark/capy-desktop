/** The menu-bar menu as plain data (kept free of electron imports so it can be unit-tested). */

export type TrayPlatform = "youtube" | "instagram" | "tiktok";
export interface TraySummary {
  review: number;
  activeCount: number;
  nextPost?: { at: number; platforms: TrayPlatform[] };
  /** Creators automation watches. */
  watching?: number;
}
export interface TrayItem {
  label: string;
  id?: "open" | "queue" | "automation" | "pause" | "quit";
  enabled?: boolean;
  separator?: boolean;
}

const NAMES: Record<TrayPlatform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

export function trayMenuModel(s: TraySummary, paused: boolean, tz: string): TrayItem[] {
  const when = s.nextPost ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(s.nextPost.at)).replace(",", "") : "";
  return [
    { label: s.nextPost ? `Next post: ${when} · ${s.nextPost.platforms.map((p) => NAMES[p]).join(", ")}` : "No posts scheduled", enabled: false },
    ...(s.review ? [{ label: `${s.review} clip${s.review === 1 ? "" : "s"} waiting for your OK`, id: "queue" as const }] : []),
    ...(s.watching ? [{ label: `Watching ${s.watching} creator${s.watching === 1 ? "" : "s"}`, id: "automation" as const }] : []),
    { label: "", separator: true },
    { label: "Open capy", id: "open" },
    { label: paused ? "Resume posting" : "Pause posting", id: "pause" },
    { label: "", separator: true },
    { label: "Quit capy", id: "quit" },
  ];
}

/** Text for a desktop notification when more clips wait for review than at the last look (not on the first look). */
export function newReviewNotice(prev: number | undefined, next: number): string | undefined {
  if (prev === undefined || next <= prev) return undefined;
  const n = next - prev;
  return `${n} new clip${n === 1 ? " is" : "s are"} waiting for your OK`;
}
