import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgeBand, ContentReview, StoryCharacter, StoryPage, StorySeries, StoryState } from "../lib/types";
import { run } from "../src/exec";
import { clipThumbnail } from "../src/render";
import { reviewContent as reviewContentImpl, type ContentInput } from "../src/content-review";
import { assembleStory } from "../src/story/assemble";
import { DEFAULT_VOICE, narrate as narrateImpl, storyTimeline } from "../src/story/narrate";
import { characterCard, composePage } from "../src/story/svg";
import * as write from "../src/story/write";
import type { AiOpts } from "../src/story/write";
import { slug } from "../src/util";
import { publicAccounts } from "./accounts";
import { OUTPUT_ROOT, toMediaUrl } from "./paths";
import { fingerprint, queue, upsertForRender } from "./queue";
import { effective } from "./settings";

/**
 * Original kids' stories: series (bible + cast) and stories under <output>/stories/<seriesId>/<storyId>/.
 * Each step writes files and saves story.json, so a step can be redone and a restart loses nothing but the step
 * in progress. Nothing is posted from here: a finished story goes to the queue's review list like any clip.
 */

export interface StoryDeps {
  ai(): Promise<AiOpts>;
  drawCharacter: typeof write.drawCharacter;
  writeStory: typeof write.writeStory;
  reviewStory: typeof write.reviewStory;
  reviseStory: typeof write.reviseStory;
  drawBackground: typeof write.drawBackground;
  storyPublish: typeof write.storyPublish;
  rasterize(svgFile: string, pngFile: string): Promise<void>;
  narrate(text: string, voice: string, out: string): Promise<number>;
  assemble: typeof assembleStory;
  cover(mp4: string, jpg: string): Promise<void>;
  reviewContent(i: ContentInput, o: AiOpts): Promise<ContentReview>;
}

const defaultDeps = (): StoryDeps => ({
  ai: async () => {
    const app = effective();
    return { agent: app.agent, model: app.agent === "claude" ? app.model : app.models[app.agent] };
  },
  drawCharacter: write.drawCharacter,
  writeStory: write.writeStory,
  reviewStory: write.reviewStory,
  reviseStory: write.reviseStory,
  drawBackground: write.drawBackground,
  storyPublish: write.storyPublish,
  rasterize: async (svg, png) => void (await run("rsvg-convert", ["--background-color", "#fef9f1", "-o", png, svg])),
  narrate: narrateImpl,
  assemble: assembleStory,
  cover: (mp4, jpg) => clipThumbnail(mp4, jpg, 0.8),
  reviewContent: reviewContentImpl,
});

/** Seconds the title shows over the first page before the narration starts. */
const LEAD = 2.4;
const pad2 = (n: number) => String(n).padStart(2, "0");
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const busyError = () => Object.assign(new Error("This story is busy. Wait for the current step to finish."), { status: 409 });
const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404 });

export interface NewSeries {
  title: string;
  ageBand: AgeBand;
  tone: string;
  values: string[];
  artStyle: string;
  characters: { name: string; description: string }[];
}

export class StoryManager {
  series = new Map<string, StorySeries>();
  stories = new Map<string, StoryState>();
  private busy = new Set<string>();
  private loaded?: Promise<void>;

  constructor(private deps: StoryDeps = defaultDeps()) {}

  get root() {
    return path.join(OUTPUT_ROOT, "stories");
  }
  seriesDir(id: string) {
    return path.join(this.root, id);
  }
  storyDir(s: Pick<StoryState, "seriesId" | "id">) {
    return path.join(this.root, s.seriesId, s.id);
  }

  /** Load everything from disk once; work that was in progress goes back to a state the user can act on. */
  init(): Promise<void> {
    return (this.loaded ??= this.load());
  }

  private async load() {
    for (const sid of await readdir(this.root).catch(() => [] as string[])) {
      const ser = await readJson<StorySeries>(path.join(this.seriesDir(sid), "series.json"));
      if (!ser) continue;
      for (const c of ser.characters) if (c.status === "drawing") Object.assign(c, { status: "error", error: "Interrupted; draw again" });
      this.series.set(ser.id, ser);
      for (const stid of await readdir(this.seriesDir(sid)).catch(() => [] as string[])) {
        const st = await readJson<StoryState>(path.join(this.seriesDir(sid), stid, "story.json"));
        if (!st) continue;
        for (const p of st.pages) if (p.status === "drawing") p.status = "pending";
        if (st.status === "writing") Object.assign(st, { status: st.pages.length ? "script" : "error", error: st.pages.length ? undefined : "Interrupted while writing. Write it again." });
        if (st.status === "illustrating" || st.status === "rendering") st.status = "pages";
        this.stories.set(st.id, st);
      }
    }
  }

  listSeries() {
    return [...this.series.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  getSeries(id: string) {
    return this.series.get(id);
  }
  listStories(seriesId: string) {
    return [...this.stories.values()].filter((s) => s.seriesId === seriesId).sort((a, b) => b.createdAt - a.createdAt);
  }
  getStory(id: string) {
    return this.stories.get(id);
  }

  // ---------- series ----------

  async createSeries(n: NewSeries): Promise<StorySeries> {
    await this.init();
    const used = new Set<string>();
    const characters: StoryCharacter[] = n.characters
      .filter((c) => c.name.trim())
      .map((c) => {
        let id = slug(c.name).slice(0, 24) || "character";
        while (used.has(id)) id = `${id}-2`;
        used.add(id);
        return { id, name: c.name.trim(), description: c.description.trim(), status: "drawing" };
      });
    if (!characters.length) throw new Error("Add at least one character");
    const now = Date.now();
    const s: StorySeries = { id: newId("ser"), title: n.title.trim(), ageBand: n.ageBand, tone: n.tone.trim(), values: n.values, artStyle: n.artStyle.trim(), characters, createdAt: now, updatedAt: now };
    this.series.set(s.id, s);
    await this.saveSeries(s);
    void this.drawCharacters(s, characters.map((c) => c.id));
    return s;
  }

  async redrawCharacter(seriesId: string, charId: string) {
    const s = this.series.get(seriesId);
    const c = s?.characters.find((x) => x.id === charId);
    if (!s || !c) throw notFound("Character");
    if (c.status === "drawing") throw busyError();
    Object.assign(c, { status: "drawing", error: undefined });
    await this.saveSeries(s);
    void this.drawCharacters(s, [charId]);
    return s;
  }

  private async drawCharacters(s: StorySeries, ids: string[]) {
    const ai = await this.deps.ai();
    const dir = path.join(this.seriesDir(s.id), "chars");
    await mkdir(dir, { recursive: true });
    await pool(ids, 2, async (id) => {
      const c = s.characters.find((x) => x.id === id);
      if (!c) return;
      try {
        c.svg = await this.deps.drawCharacter(s, c, ai);
        const svgFile = path.join(dir, `${c.id}.svg`);
        await writeFile(svgFile, characterCard(c.svg));
        await this.deps.rasterize(svgFile, path.join(dir, `${c.id}.png`));
        Object.assign(c, { status: "ready", error: undefined, imageUrl: `${toMediaUrl(path.join(dir, `${c.id}.png`))}?v=${Date.now()}` });
      } catch (e) {
        Object.assign(c, { status: "error", error: errText(e) });
      }
      await this.saveSeries(s);
    });
  }

  // ---------- story: words ----------

  async createStory(seriesId: string, brief: string): Promise<StoryState> {
    await this.init();
    const s = this.series.get(seriesId);
    if (!s) throw notFound("Series");
    const now = Date.now();
    const st: StoryState = { id: newId("st"), seriesId, title: "Writing…", brief: brief.trim(), moral: "", status: "writing", pages: [], log: [], createdAt: now, updatedAt: now };
    this.stories.set(st.id, st);
    await this.saveStory(st);
    void this.task(st, () => this.writeAndReview(st, s));
    return st;
  }

  /** Ask for another version with the user's (or the reviewer's) notes. */
  async rewrite(id: string, notes: string[]) {
    const { st, s } = this.ready(id, ["script", "pages", "done", "error"]);
    st.status = "writing";
    await this.saveStory(st);
    void this.task(st, async () => {
      const ai = await this.deps.ai();
      const next = notes.length && st.pages.length ? await this.deps.reviseStory(s, st, notes, ai) : await this.deps.writeStory(s, st.brief, ai);
      Object.assign(st, next, { video: undefined, contentReview: undefined, publish: undefined, queuedAt: undefined });
      this.log(st, notes.length ? "Rewritten with your notes" : "Written again");
      st.review = await this.deps.reviewStory(s, st, ai);
      st.status = "script";
    });
    return st;
  }

  private async writeAndReview(st: StoryState, s: StorySeries) {
    const ai = await this.deps.ai();
    Object.assign(st, await this.deps.writeStory(s, st.brief, ai));
    this.log(st, `Written: ${st.pages.length} pages`);
    let review = await this.deps.reviewStory(s, st, ai);
    if (review.verdict === "fix" && review.notes.length) {
      // one automatic round with the reviewer's notes; anything left is for the user
      this.log(st, `Reviewer asked for changes: ${review.notes.join(" · ")}`);
      Object.assign(st, await this.deps.reviseStory(s, st, review.notes, ai));
      review = await this.deps.reviewStory(s, st, ai);
    }
    st.review = review;
    this.log(st, `Story reviewer: ${review.verdict}`);
    st.status = "script";
  }

  /** The user's edits to the script. A changed scene or cast means that page's picture is drawn again. */
  async updateStory(id: string, patch: { title?: string; pages?: Pick<StoryPage, "text" | "scene" | "cast">[] }) {
    const { st } = this.ready(id, ["script", "pages", "done"]);
    if (patch.title?.trim()) st.title = patch.title.trim();
    if (patch.pages) {
      st.pages = patch.pages.map((p, i) => {
        const old = st.pages[i];
        const same = old && old.scene === p.scene && JSON.stringify(old.cast) === JSON.stringify(p.cast);
        return { ...(old ?? {}), text: p.text.trim(), scene: p.scene.trim(), cast: p.cast, status: same ? old!.status : "pending", ...(same ? {} : { imageUrl: undefined }) };
      });
      if (st.status === "done") st.status = "pages"; // the video no longer matches the words
    }
    await this.saveStory(st);
    return st;
  }

  // ---------- story: pictures ----------

  async approveScript(id: string) {
    const { st, s } = this.ready(id, ["script", "pages", "done"]);
    if (!st.pages.length) throw new Error("The story has no pages");
    if (st.review?.verdict === "block") throw Object.assign(new Error("The story reviewer blocked this story. Rewrite it first."), { status: 409 });
    if (s.characters.some((c) => c.status !== "ready")) throw Object.assign(new Error("Wait for the characters to be drawn (or draw the failed ones again)"), { status: 409 });
    st.status = "illustrating";
    await this.saveStory(st);
    void this.task(st, async () => {
      const todo = st.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.status !== "ready");
      await pool(todo, 2, ({ i }) => this.drawPage(st, s, i));
      st.status = "pages";
      const failed = todo.filter(({ i }) => st.pages[i]!.status === "error").length;
      this.log(st, `Illustrated ${todo.length - failed} page${todo.length - failed === 1 ? "" : "s"}${failed ? `; ${failed} failed (draw them again)` : ""}`);
    });
    return st;
  }

  async redrawPage(id: string, i: number) {
    const { st, s } = this.ready(id, ["pages", "done"]);
    if (!st.pages[i]) throw notFound("Page");
    st.status = "illustrating";
    await this.saveStory(st);
    void this.task(st, async () => {
      await this.drawPage(st, s, i);
      st.status = "pages";
    });
    return st;
  }

  private async drawPage(st: StoryState, s: StorySeries, i: number) {
    const p = st.pages[i]!;
    p.status = "drawing";
    await this.saveStory(st);
    try {
      const dir = path.join(this.storyDir(st), "pages");
      await mkdir(dir, { recursive: true });
      const chars = s.characters.filter((c) => c.svg).map((c) => ({ id: c.id, svg: c.svg! }));
      const svgFile = path.join(dir, `${pad2(i + 1)}.svg`);
      const png = path.join(dir, `${pad2(i + 1)}.png`);
      // a drawing that won't render (broken SVG) gets one fresh attempt before the page is marked failed
      for (let attempt = 1; ; attempt++) {
        const bg = await this.deps.drawBackground(s, p, await this.deps.ai());
        // the scene alone is kept, so a render can rebuild the page with the characters as they are then
        await writeFile(path.join(dir, `${pad2(i + 1)}.bg.svg`), bg);
        await writeFile(svgFile, composePage(bg, chars, p.cast));
        try {
          await this.deps.rasterize(svgFile, png);
          break;
        } catch (e) {
          if (attempt >= 2) throw new Error(`The drawing for this page wouldn't render (${errText(e)}). Draw it again.`);
        }
      }
      Object.assign(p, { status: "ready", error: undefined, imageUrl: `${toMediaUrl(png)}?v=${Date.now()}` });
    } catch (e) {
      Object.assign(p, { status: "error", error: errText(e) });
    }
    await this.saveStory(st);
  }

  // ---------- story: sound and video ----------

  async render(id: string, voice = DEFAULT_VOICE) {
    const { st, s } = this.ready(id, ["pages", "done"]);
    if (st.pages.some((p) => p.status !== "ready")) throw Object.assign(new Error("Every page needs its picture first"), { status: 409 });
    st.status = "rendering";
    st.voice = voice;
    await this.saveStory(st);
    void this.task(st, async () => {
      const dir = this.storyDir(st);
      await this.recomposePages(st, s);
      await mkdir(path.join(dir, "audio"), { recursive: true });
      const narration: string[] = [];
      const durations: number[] = [];
      for (let i = 0; i < st.pages.length; i++) {
        const f = path.join(dir, "audio", `${pad2(i + 1)}.aiff`);
        durations.push(await this.deps.narrate(st.pages[i]!.text, voice, f));
        narration.push(f);
      }
      const tl = storyTimeline(st.pages.map((p, i) => ({ text: p.text, duration: durations[i]! })), 0.7, LEAD);
      const base = `${slug(st.title).slice(0, 40) || "story"}`;
      const out = path.join(dir, `${base}.mp4`);
      const { duration } = await this.deps.assemble({
        pages: st.pages.map((_, i) => path.join(dir, "pages", `${pad2(i + 1)}.png`)),
        narration,
        starts: tl.starts,
        total: tl.total,
        words: tl.words,
        title: st.title,
        lead: LEAD,
        assFile: path.join(dir, "story.ass"),
        out,
      });
      const jpg = path.join(dir, `${base}.jpg`);
      await this.deps.cover(out, jpg).catch(() => {});
      st.video = { url: `${toMediaUrl(out)}?v=${Date.now()}`, file: out, duration, coverUrl: existsSync(jpg) ? `${toMediaUrl(jpg)}?v=${Date.now()}` : undefined };
      this.log(st, `Rendered ${Math.round(duration)}s with ${voice}`);
      const ai = await this.deps.ai();
      st.publish = await this.deps.storyPublish(s, st, ai).catch(() => ({ ytTitle: `${st.title} | Bedtime Story #shorts`.slice(0, 100), description: st.moral, hashtags: ["bedtimestory", "kidsstories", "readaloud", "shorts"] }));
      st.contentReview = await this.deps.reviewContent(
        { profile: "kids", videoTitle: s.title, clipTitle: st.title, hook: st.title, transcript: st.pages.map((p) => p.text).join(" "), ytTitle: st.publish.ytTitle, caption: st.publish.description, hashtags: st.publish.hashtags },
        ai,
      );
      this.log(st, `AI review: ${st.contentReview.verdict}`);
      st.queuedAt = undefined;
      st.status = "done";
    });
    return st;
  }

  /**
   * Rebuild every page from its saved scene and the series' current characters (a redrawn character or a layout
   * fix shows up everywhere, with no new drawing). Pages made before scenes were kept stay as they are.
   */
  private async recomposePages(st: StoryState, s: StorySeries) {
    const dir = path.join(this.storyDir(st), "pages");
    const chars = s.characters.filter((c) => c.svg).map((c) => ({ id: c.id, svg: c.svg! }));
    for (let i = 0; i < st.pages.length; i++) {
      const bg = await readFile(path.join(dir, `${pad2(i + 1)}.bg.svg`), "utf8").catch(() => null);
      if (bg === null) continue;
      const svgFile = path.join(dir, `${pad2(i + 1)}.svg`);
      await writeFile(svgFile, composePage(bg, chars, st.pages[i]!.cast));
      await this.deps.rasterize(svgFile, path.join(dir, `${pad2(i + 1)}.png`));
      st.pages[i]!.imageUrl = `${toMediaUrl(path.join(dir, `${pad2(i + 1)}.png`))}?v=${Date.now()}`;
    }
  }

  /** Into Queue → Waiting for your OK on every connected platform (YouTube marks it made for kids). */
  async sendToQueue(id: string): Promise<number> {
    const { st, s } = this.ready(id, ["done"]);
    if (!st.video) throw new Error("Render the video first");
    const platforms = publicAccounts()
      .filter((a) => a.connected && a.autoPost)
      .map((a) => a.platform);
    if (!platforms.length) throw Object.assign(new Error("No posting account is connected. Connect one in Settings → Posting accounts."), { status: 409 });
    queue().mutate((e) =>
      upsertForRender(
        e,
        {
          jobId: `story-${st.id}`,
          n: 1,
          start: 0,
          end: st.video!.duration,
          clipTitle: st.title,
          videoTitle: s.title,
          videoUrl: st.video!.url,
          thumbUrl: st.video!.coverUrl,
          thumbAt: 0.8,
          publish: st.publish,
          hook: st.title,
          aiReview: st.contentReview,
          madeForKids: true,
        },
        platforms,
        new Date(),
      ),
    );
    st.queuedAt = Date.now();
    this.log(st, `Sent to the review queue (${platforms.join(", ")})`);
    await this.saveStory(st);
    return platforms.length;
  }

  async deleteStory(id: string) {
    const st = this.stories.get(id);
    if (!st) throw notFound("Story");
    if (this.busy.has(id)) throw busyError();
    this.stories.delete(id);
    await rm(this.storyDir(st), { recursive: true, force: true });
  }

  // ---------- plumbing ----------

  private ready(id: string, allowed: StoryState["status"][]) {
    const st = this.stories.get(id);
    if (!st) throw notFound("Story");
    if (this.busy.has(id) || !allowed.includes(st.status)) throw busyError();
    const s = this.series.get(st.seriesId);
    if (!s) throw notFound("Series");
    return { st, s };
  }

  /** Run one step of a story in the background; errors land on the story, never crash the server. */
  private async task(st: StoryState, fn: () => Promise<void>) {
    this.busy.add(st.id);
    try {
      await fn();
      st.error = undefined;
    } catch (e) {
      st.error = errText(e);
      st.status = st.pages.length ? (st.pages.every((p) => p.status === "ready") ? "pages" : "script") : "error";
      this.log(st, `Error: ${st.error}`);
    } finally {
      this.busy.delete(st.id);
      await this.saveStory(st);
    }
  }

  private log(st: StoryState, msg: string) {
    st.log = [...st.log, { t: Date.now(), msg }].slice(-100);
  }

  private async saveSeries(s: StorySeries) {
    s.updatedAt = Date.now();
    await mkdir(this.seriesDir(s.id), { recursive: true });
    await writeFile(path.join(this.seriesDir(s.id), "series.json"), JSON.stringify(s, null, 2));
  }

  private async saveStory(st: StoryState) {
    st.updatedAt = Date.now();
    await mkdir(this.storyDir(st), { recursive: true });
    await writeFile(path.join(this.storyDir(st), "story.json"), JSON.stringify(st, null, 2));
  }
}

/** The file the poster posts for a story's queue entry; "changed" if it was re-rendered after the approval. */
export function storyClipFile(st: StoryState | undefined, e: { fp?: string }, exists: (f: string) => boolean = existsSync): { file: string; thumbFile?: string } | "missing" | "changed" | "rendering" {
  if (st?.status === "rendering") return "rendering"; // the mp4 is being rewritten: post it on a later tick
  if (!st?.video || !exists(st.video.file)) return "missing";
  if (e.fp && fingerprint(0, st.video.duration) !== e.fp) return "changed";
  const jpg = st.video.file.replace(/\.mp4$/, ".jpg");
  return { file: st.video.file, thumbFile: exists(jpg) ? jpg : undefined };
}

async function readJson<T>(f: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(f, "utf8")) as T;
  } catch {
    return null;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

declare global {
  // eslint-disable-next-line no-var
  var __capyStories: StoryManager | undefined;
}

/** The app's story manager (one per server process; survives dev reloads). */
export function stories(): StoryManager {
  if (!globalThis.__capyStories) globalThis.__capyStories = new StoryManager();
  else if (Object.getPrototypeOf(globalThis.__capyStories) !== StoryManager.prototype) Object.setPrototypeOf(globalThis.__capyStories, StoryManager.prototype);
  return globalThis.__capyStories;
}
