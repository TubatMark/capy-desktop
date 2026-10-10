import { describe, expect, it, vi } from "vitest";
import path from "node:path";

vi.hoisted(() => {
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const p = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-channel-"));
  process.env.CAPY_OUTPUT = p.join(root, "out");
  process.env.CAPY_DATA_DIR = p.join(root, "data");
});

import { fetchSnapshot, updateVideoText, type ChannelDeps } from "../server/channel";
import { research, SEARCHES_PER_DAY, tuneSeo, type SeoDeps } from "../server/seo";

const READ = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
const ALL = `${READ} https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.force-ssl`;

type Route = [RegExp, (url: URL, init: RequestInit) => unknown, number?];
function api(routes: Route[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (u: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(u));
    calls.push({ url, init });
    const r = routes.find(([re]) => re.test(url.href));
    if (!r) throw new Error(`unexpected ${url.href}`);
    return new Response(JSON.stringify(r[1](url, init)), { status: r[2] ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const deps = (f: typeof fetch): ChannelDeps => ({ fetch: f, token: async () => "T", now: () => new Date("2026-10-06T12:00:00Z") });

const channel = { items: [{ id: "UC1", snippet: { title: "Pip & Lulu", thumbnails: {} }, statistics: { subscriberCount: "5" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] };
const video = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  snippet: { title: `Video ${id}`, description: "d", tags: [], publishedAt: `2026-10-0${id === "a" ? 1 : 2}T00:00:00Z`, categoryId: "1", defaultLanguage: "en", ...over },
  statistics: { viewCount: "10" },
  contentDetails: { duration: "PT40S" },
  status: { madeForKids: true },
});

describe("channel snapshot", () => {
  it("loads the channel, every upload (paged), and the 28-day analytics", async () => {
    const { f, calls } = api([
      [/\/channels\?/, () => channel],
      [/playlistItems.*pageToken=p2/, () => ({ items: [{ contentDetails: { videoId: "b" } }] })],
      [/playlistItems/, () => ({ items: [{ contentDetails: { videoId: "a" } }], nextPageToken: "p2" })],
      [/\/videos\?/, () => ({ items: [video("a"), video("b")] })],
      [/dimensions=day/, () => ({ columnHeaders: [{ name: "day" }, { name: "views" }, { name: "estimatedMinutesWatched" }, { name: "subscribersGained" }, { name: "subscribersLost" }], rows: [["2026-10-01", 4, 2, 1, 0]] })],
      [/dimensions=video/, () => ({ columnHeaders: [{ name: "video" }, { name: "views" }, { name: "estimatedMinutesWatched" }, { name: "averageViewPercentage" }], rows: [["a", 30, 10, 80], ["b", 10, 2, 40]] })],
      [/metrics=averageViewPercentage(?:&|$)/, () => ({ columnHeaders: [{ name: "averageViewPercentage" }], rows: [[93]] })],
      [/dimensions=insightTrafficSourceType/, () => ({ columnHeaders: [{ name: "insightTrafficSourceType" }, { name: "views" }], rows: [["SHORTS", 30]] })],
      [/insightTrafficSourceDetail/, () => ({ columnHeaders: [{ name: "insightTrafficSourceDetail" }, { name: "views" }], rows: [["bedtime story", 7]] })],
    ]);
    const s = await fetchSnapshot(deps(f), ALL);
    expect(s.channel.title).toBe("Pip & Lulu");
    expect(s.videos.map((v) => v.id)).toEqual(["b", "a"]); // newest first
    expect(s.videos.find((v) => v.id === "a")).toMatchObject({ avgViewPct: 80, minutes: 10 });
    expect(s.videos[0]!.seo).toBeTypeOf("number");
    expect(s.analytics).toMatchObject({ days: [{ day: "2026-10-01", views: 4, subsGained: 1 }], sources: [{ source: "SHORTS", views: 30 }], searches: [{ term: "bedtime story", views: 7 }], avgViewPct: 93 });
    expect(s.notes).toEqual([]);
    expect(calls.every((c) => new Headers(c.init.headers).get("authorization") === "Bearer T")).toBe(true);
    expect(calls.find((c) => /dimensions=day/.test(c.url.href))!.url.searchParams.get("startDate")).toBe("2026-09-08");
  });

  it("without the Analytics permission: everything else, and a note to reconnect", async () => {
    const { f, calls } = api([
      [/\/channels\?/, () => channel],
      [/playlistItems/, () => ({ items: [{ contentDetails: { videoId: "a" } }] })],
      [/\/videos\?/, () => ({ items: [video("a")] })],
    ]);
    const s = await fetchSnapshot(deps(f), READ);
    expect(s.analytics).toBeUndefined();
    expect(s.notes[0]).toMatch(/Reconnect YouTube/);
    expect(calls.some((c) => c.url.host.includes("youtubeanalytics"))).toBe(false);
  });

  it("an analytics report that fails becomes a note, not a failure", async () => {
    const { f } = api([
      [/\/channels\?/, () => channel],
      [/playlistItems/, () => ({ items: [] })],
      [/youtubeanalytics/, () => ({ error: { message: "nope", errors: [{ reason: "forbidden" }] } }), 403],
    ]);
    const s = await fetchSnapshot(deps(f), ALL);
    expect(s.notes.length).toBe(5);
    expect(s.notes[0]).toMatch(/Daily numbers: Reconnect YouTube/);
  });

  it("a quota refusal reads as plain words", async () => {
    const { f } = api([[/\/channels\?/, () => ({ error: { message: "x", errors: [{ reason: "quotaExceeded" }] } }), 403]]);
    await expect(fetchSnapshot(deps(f), ALL)).rejects.toThrow(/daily limit/);
  });

  it("updating a video keeps its category and language, and changes only the text", async () => {
    const { f, calls } = api([
      [/\/videos\?part=snippet&id=a/, () => ({ items: [video("a")] })],
      [/\/videos\?part=snippet$/, (_u, init) => JSON.parse(String(init.body))],
      [/\/videos\?part=snippet%2C/, () => ({ items: [video("a", { title: "New" })] })],
    ]);
    const v = await updateVideoText(deps(f), "a", { title: "New", description: "Better", tags: ["x"] });
    const put = calls.find((c) => c.init.method === "PUT")!;
    expect(JSON.parse(String(put.init.body))).toEqual({ id: "a", snippet: { categoryId: "1", defaultLanguage: "en", title: "New", description: "Better", tags: ["x"] } });
    expect(v.title).toBe("New");
  });
});

describe("keyword research", () => {
  const sdeps = (f: typeof fetch, token: string | null = "T", day = "2026-10-06T12:00:00Z"): SeoDeps => {
    const file = path.join(process.env.CAPY_DATA_DIR!, `seo-${Math.random()}.json`);
    return { fetch: f, token: async () => token, now: () => new Date(day), cacheFile: () => file };
  };

  it("merges autocomplete and ranking, and caches both", async () => {
    globalThis.__capySeoCache = undefined;
    const { f, calls } = api([
      [/suggestqueries/, (u) => [u.searchParams.get("q"), [`${u.searchParams.get("q")} for kids`, "bedtime story"]]],
      [/\/search\?/, () => ({ items: [{ id: { videoId: "r1" }, snippet: { channelTitle: "Sleepy" } }] })],
      [/\/videos\?/, () => ({ items: [video("r1", { title: "Bedtime story for kids", tags: ["bedtime story"] })] })],
    ]);
    const d = sdeps(f);
    const r = await research("Bedtime Story", {}, d);
    expect(r.seed).toBe("bedtime story");
    expect(r.ranking[0]).toMatchObject({ id: "r1", channel: "Sleepy", views: 10 });
    expect(r.keywords.find((k) => k.term === "bedtime story for kids")!.sources).toEqual(["autocomplete"]);
    const n = calls.length;
    await research("bedtime story", {}, d);
    expect(calls.length).toBe(n); // all from the cache
  });

  it("stops searching at the daily cap (autocomplete still works) and says why", async () => {
    globalThis.__capySeoCache = undefined;
    const { f, calls } = api([
      [/suggestqueries/, () => ["q", ["x"]]],
      [/\/search\?/, () => ({ items: [] })],
    ]);
    const d = sdeps(f);
    for (let i = 0; i < SEARCHES_PER_DAY; i++) await research(`topic ${i}`, {}, d);
    const r = await research("one more", {}, d);
    expect(r.notes.join(" ")).toMatch(/searches are used/);
    expect(calls.filter((c) => c.url.pathname === "/youtube/v3/search").length).toBe(SEARCHES_PER_DAY);
    expect(r.keywords.length).toBeGreaterThan(0);
  });

  it("two researches of the same topic at once pay for one search", async () => {
    globalThis.__capySeoCache = undefined;
    const { f, calls } = api([
      [/suggestqueries/, () => ["q", ["x"]]],
      [/\/search\?/, () => ({ items: [] })],
    ]);
    const d = sdeps(f);
    await Promise.all([research("same topic", {}, d), research("same topic", {}, d)]);
    expect(calls.filter((c) => c.url.pathname === "/youtube/v3/search").length).toBe(1);
  });

  it("without YouTube connected: autocomplete only, with a note", async () => {
    globalThis.__capySeoCache = undefined;
    const { f } = api([[/suggestqueries/, () => ["q", ["kids story"]]]]);
    const r = await research("kids story", {}, sdeps(f, null));
    expect(r.ranking).toEqual([]);
    expect(r.notes[0]).toMatch(/Connect YouTube/);
  });
});

describe("tuneSeo", () => {
  const publish = { ytTitle: "Pip and the Sled", description: "A story.", hashtags: ["shorts"] };
  const ai = { agent: "claude" as const };

  it("uses the rewrite and reports before/after", async () => {
    const out = await tuneSeo({ kind: "kids", publish, about: "a story" }, ai, {
      seedPhrases: async () => ["bedtime story"],
      research: async (seed) => ({ seed, keywords: [{ term: "bedtime story", score: 80, sources: ["autocomplete"] }], ranking: [], tags: [], notes: [], at: 0 }),
      optimizeSeo: async (i) => {
        const text = { title: "Bedtime Story: Pip and the Sled", description: "x", hashtags: ["shorts"], tags: ["bedtime story"] };
        const report = { score: 80, before: 30, keyword: "bedtime story", checks: [], at: 0 };
        return { text, report, improved: i.research?.seed === "bedtime story", rewrite: text, rewriteReport: report };
      },
    });
    expect(out.publish).toEqual({ ytTitle: "Bedtime Story: Pip and the Sled", description: "x", hashtags: ["shorts"], tags: ["bedtime story"] });
    expect(out.seo).toMatchObject({ score: 80, before: 30 });
  });

  it("never blocks: a failing AI leaves the text as it was, with a note", async () => {
    const out = await tuneSeo({ kind: "short", publish, about: "x" }, ai, {
      seedPhrases: async () => {
        throw new Error("timeout");
      },
      optimizeSeo: async () => {
        throw new Error("AI down");
      },
    });
    expect(out.publish).toBe(publish);
    expect(out.seo.note).toMatch(/didn't run \(AI down\)/);
    expect(out.seo.score).toBeTypeOf("number");
  });
});

it("automatic draft tuning does not fetch or consume provider rankings, including historical injected results", async () => {
  const external = vi.fn(async () => ({ seed: "remote", keywords: [{ term: "derived bait", score: 99, sources: ["ranking" as const] }], ranking: [{ id: "raw", title: "API title", channel: "provider", views: 0 }], tags: ["aggregate tag"], notes: [], at: 0 }));
  const rewrite = vi.fn(async (input) => {
    expect(input).not.toHaveProperty("research");
    expect(input).not.toHaveProperty("channelTerms");
    return { text: input.text, report: { score: 40, checks: [], at: 0 }, improved: false, rewrite: input.text, rewriteReport: { score: 40, checks: [], at: 0 } };
  });
  await tuneSeo({ kind: "short", publish: { ytTitle: "Local draft", description: "Local transcript", hashtags: [] }, about: "Local footage", seeds: ["seed"] }, { agent: "claude" }, { research: external, optimizeSeo: rewrite });
  expect(external).not.toHaveBeenCalled();
  expect(rewrite).toHaveBeenCalledOnce();
  const { rewritePrompt } = await import("../src/seo/optimize");
  const prompt = rewritePrompt({ kind: "short", text: { title: "Local", description: "Draft", tags: [], hashtags: [] }, about: "Footage", research: await external(), channelTerms: ["cached derived phrase"] });
  expect(prompt).not.toMatch(/derived bait|aggregate tag|API title|cached derived phrase|best first/);
  expect(prompt).toContain("Local");
});

it("historical research caches cannot revive derived results and raw views retain zero versus unavailable", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const file = path.join(process.env.CAPY_DATA_DIR!, "historical-derived.json");
  await mkdir(path.dirname(file), { recursive: true });
  const now = new Date("2026-10-06T12:00:00Z");
  await writeFile(file, JSON.stringify({ day: "2026-10-06", searches: 2, suggest: { seed: { at: +now, terms: ["old derived phrase"] } }, search: { seed: { at: +now, ranking: [{ id: "old", title: "Old score", score: 99 }] } }, keywords: [{ term: "old", score: 99 }], tags: ["aggregate"] }));
  globalThis.__capySeoCache = undefined;
  const { f } = api([
    [/suggestqueries/, () => ["seed", ["raw phrase"]]],
    [/\/search\?/, () => ({ items: [{ id: { videoId: "zero" } }, { id: { videoId: "unknown" } }] })],
    [/\/videos\?/, () => ({ items: [{ ...video("zero"), statistics: { viewCount: "0" } }, { ...video("unknown"), statistics: {} }] })],
  ]);
  const out = await research("seed", {}, { fetch: f, token: async () => "fixture", now: () => now, cacheFile: () => file });
  expect(out.rawVersion).toBe(1);
  expect(out.keywords).toEqual([{ term: "raw phrase", sources: ["autocomplete"] }]);
  expect(out.tags).toEqual([]);
  expect(out.ranking.map((r) => r.views)).toEqual([0, undefined]);
  expect(JSON.stringify(out)).not.toMatch(/old derived|Old score|aggregate|"score"/);
  await expect((await import("node:fs/promises")).readFile(file, "utf8").then(JSON.parse)).resolves.toMatchObject({ rawVersion: 1, searches: 3 });
});
