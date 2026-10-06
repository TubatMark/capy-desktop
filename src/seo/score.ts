import type { SeoCheck, SeoReport, SeoText } from "../../lib/types";

/**
 * A deterministic YouTube SEO score: weighted checks of the title, description, hashtags and tags against the
 * target keyword. Every check carries a tip, so the score explains itself. No AI, no network.
 */

export type SeoKind = "short" | "kids" | "video";

const STOP = new Set(["a", "an", "the", "for", "of", "to", "and", "in", "on", "with", "at", "by", "is", "my", "your"]);
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/#\S+/g, " ")
    .replace(/['’]s\b/g, " s")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const words = (s: string) => norm(s).split(" ").filter((w) => w && !STOP.has(w));

/** The keyword is in the text as a phrase, or every one of its meaningful words is. */
export function matchesKeyword(text: string, keyword: string): boolean {
  const t = ` ${norm(text)} `;
  const k = norm(keyword);
  if (!k) return false;
  if (t.includes(` ${k} `)) return true;
  const have = new Set(t.trim().split(" "));
  const need = words(keyword);
  return need.length > 0 && need.every((w) => have.has(w));
}

/** Where the keyword starts in the (normalised) text, or -1. Word matches count from their last word. */
function keywordAt(text: string, keyword: string): number {
  const t = norm(text);
  const k = norm(keyword);
  const i = ` ${t} `.indexOf(` ${k} `);
  if (i >= 0) return i;
  if (!matchesKeyword(text, keyword)) return -1;
  return Math.max(...words(keyword).map((w) => ` ${t} `.indexOf(` ${w} `)));
}

const KIDS_CTA = /\b(subscribe|smash|hit (the )?(like|bell)|like (this|the) video|comment (below|down)|turn on (the )?notifications?)\b/i;
const bare = (h: string) => h.replace(/^#/, "").trim().toLowerCase();
/** The description without its all-hashtag lines (what a viewer reads as text). */
const prose = (d: string) =>
  d
    .split("\n")
    .filter((l) => !/^\s*(#\S+\s*)+$/.test(l))
    .join("\n")
    .trim();

export function scoreSeo(t: SeoText, o: { keyword?: string; kind: SeoKind }): Omit<SeoReport, "at"> {
  const kw = o.keyword?.trim();
  const checks: SeoCheck[] = [];
  const add = (id: string, label: string, weight: number, pass: boolean, tip: string) => checks.push({ id, label, weight, pass, tip: pass ? undefined : tip });
  const title = t.title.trim();
  const visibleTitle = title.replace(/#\S+/g, "").trim();
  const desc = prose(t.description);
  const hashtags = [...new Set([...t.hashtags.map(bare), ...(t.title + " " + t.description).match(/#[\p{L}\p{N}_]+/gu)?.map(bare) ?? []].filter(Boolean))];
  const tags = [...new Set(t.tags.map((x) => x.trim().toLowerCase()).filter(Boolean))];

  if (kw) {
    const at = keywordAt(visibleTitle, kw);
    add("title-keyword", "Keyword early in the title", 20, at >= 0 && at <= 50, at < 0 ? `Put "${kw}" in the title: it's what search matches first.` : `Move "${kw}" to the start of the title.`);
  }
  add("title-length", "Title length fits search", 10, visibleTitle.length >= 20 && visibleTitle.length <= 70, visibleTitle.length < 20 ? "Say more in the title (20–70 characters)." : "Keep the title under 70 characters; search cuts the rest.");
  const loud = visibleTitle.split(/\s+/).filter((w) => w.replace(/[^A-Za-z]/g, "").length > 3);
  const caps = loud.filter((w) => w === w.toUpperCase() && /[A-Z]/.test(w)).length;
  add("title-caps", "Title isn't shouting", 5, !loud.length || caps / loud.length < 0.3, "Use normal capitalisation; an all-caps title reads as clickbait.");
  if (kw) add("desc-keyword", "Keyword in the description's opening", 15, matchesKeyword(desc.slice(0, 150), kw), `Mention "${kw}" in the first sentence of the description (the part search shows).`);
  const minDesc = o.kind === "video" ? 250 : 120;
  add("desc-length", "Description gives search something to read", 10, desc.length >= minDesc, `Write at least ${minDesc} characters: what happens, who it's for, and the keywords in plain sentences.`);
  add(
    "hashtags",
    "3–8 hashtags",
    10,
    hashtags.length >= 3 && hashtags.length <= 8,
    hashtags.length > 60 ? "Over 60 hashtags and YouTube ignores all of them. Keep 3–5." : hashtags.length > 8 ? "Too many hashtags look spammy; keep the best 3–5 (the first three show above the title)." : "Add 3–5 hashtags; the first three show above the title.",
  );
  if (o.kind !== "video") add("shorts-tag", "#shorts", 5, hashtags.includes("shorts"), "Add #shorts so YouTube files it with Shorts.");
  add("tags-present", "Search tags", 10, tags.length >= 5, "Add 5–15 tags: the keyword, its variants and common misspellings.");
  if (kw) add("tags-keyword", "Keyword in the tags", 10, tags.some((x) => matchesKeyword(x, kw)), `Add "${kw}" as a tag.`);
  add("tags-length", "Tags within YouTube's 500 characters", 5, tags.join(",").length <= 500, "Trim the tags to 500 characters; YouTube rejects more.");
  if (o.kind === "kids") add("kids-cta", "No calls to action aimed at children", 10, !KIDS_CTA.test(`${title}\n${t.description}`), 'Remove "subscribe / like / comment" lines: made-for-kids videos may not ask children to act.');

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const got = checks.reduce((n, c) => n + (c.pass ? c.weight : 0), 0);
  return { score: Math.round((got / total) * 100), keyword: kw, checks };
}
