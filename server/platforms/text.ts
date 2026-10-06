import type { Platform, PostText } from "../../lib/types";

/** The clip's AI-written upload text (ClipState.publish). */
export type Publish = { ytTitle: string; description: string; hashtags: string[]; tags?: string[] };

const bare = (h: string) => h.replace(/^#/, "").replace(/\s+/g, "");
const tagsOf = (p: Publish) => [...new Set(p.hashtags.map(bare).filter(Boolean))];
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + "…");
/** The description without its all-hashtags lines: each platform places hashtags its own way. */
const body = (d: string) =>
  d
    .split("\n")
    .filter((l) => !/^\s*(#\S+\s*)+$/.test(l))
    .join("\n")
    .trim();

export function youtubeText(p: Publish): PostText {
  // search tags first (they're chosen for search), then the hashtags; YouTube caps the list at 500 characters
  const tags: string[] = [];
  for (const t of new Set([...(p.tags ?? []).map((x) => x.trim()).filter(Boolean), ...tagsOf(p)])) if ([...tags, t].join(",").length <= 500) tags.push(t);
  return { title: cut(p.ytTitle.trim(), 100), description: cut(p.description.trim(), 5000), tags };
}

export function instagramText(p: Publish, hook?: string): PostText {
  const tags = tagsOf(p)
    .slice(0, 30)
    .map((t) => `#${t}`)
    .join(" ");
  const head = [hook?.trim(), body(p.description)].filter(Boolean).join("\n\n");
  return { caption: cut(head, 2200 - tags.length - 2) + (tags ? `\n\n${tags}` : "") };
}

export function tiktokText(p: Publish): PostText {
  const tags = tagsOf(p)
    .map((t) => `#${t}`)
    .join(" ");
  const title = p.ytTitle.replace(/#\S+/g, "").trim();
  return { caption: cut(`${title}\n\n${body(p.description)}`.trim(), 2200 - tags.length - 1) + (tags ? ` ${tags}` : "") };
}

export function postTextFor(platform: Platform, p: Publish, hook?: string): PostText {
  return platform === "youtube" ? youtubeText(p) : platform === "instagram" ? instagramText(p, hook) : tiktokText(p);
}
