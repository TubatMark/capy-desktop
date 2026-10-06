import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgeBand, ContentReview, StoryAssessment, StoryCharacter, StoryPage, StoryPlan, StorySeries, StoryState } from "../lib/types";
import { run } from "../src/exec";
import { clipThumbnail } from "../src/render";
import { reviewContent as reviewContentImpl, type ContentInput } from "../src/content-review";
import { assembleStory } from "../src/story/assemble";
import { DEFAULT_VOICE, narrate as narrateImpl, storyTimeline } from "../src/story/narrate";
import { characterCard, composePage } from "../src/story/svg";
import * as write from "../src/story/write";
import type { AiOpts } from "../src/story/write";
import { slug } from "../src/util";
import { research, tuneSeo as tuneSeoImpl } from "./seo";
import { SerialWorker } from "./assessor";
import { planStory, storyName } from "../src/story/plan";
import { assessStory } from "../src/story/assess";
import { seedPhrases } from "../src/seo/optimize";
import { publicAccounts } from "./accounts";
import { OUTPUT_ROOT, toMediaUrl } from "./paths";
import { fingerprint, queue, upsertForRender } from "./queue";
import { effective } from "./settings";
import { saveJsonAtomic } from "./json-file";

export { saveJsonAtomic };

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
  tuneSeo: typeof tuneSeoImpl;
  /** Keyword research + the plan, before writing. */
  plan(series: StorySeries, brief: string, ai: AiOpts): Promise<StoryPlan>;
  assess: typeof assessStory;
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
  tuneSeo: (i, ai) => tuneSeoImpl(i, ai),
  plan: async (s, brief, ai) => {
    const about = `${brief}. A read-aloud story for ages ${s.ageBand}. Values: ${s.values.join(", ")}.`;
    const seeds = await seedPhrases({ kind: "kids", text: { title: brief, description: "", hashtags: [], tags: [] }, about }, ai).catch(() => [] as string[]);
    const res = seeds[0] ? await research(seeds[0]).catch(() => undefined) : undefined;
    return planStory(s, brief, res, ai);
  },
  assess: assessStory,
});

/** What the script assessment was about: a change here makes it stale. */
const wordsKey = (st: StoryState) => JSON.stringify([st.title, st.pages.map((p) => [p.text, p.scene])]);
type AssessJob = { id: string; stage: StoryAssessment["stage"] };

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
  /** The assessor: its own queue, one story at a time. */
  readonly assessor: SerialWorker<AssessJob>;

  constructor(private deps: StoryDeps = defaultDeps()) {
    this.assessor = new SerialWorker<AssessJob>((j) => `${j.id}:${j.stage}`, (j) => this.runAssessment(j));
  }

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
        if (st.status === "planning" || st.status === "writing") Object.assign(st, { status: st.pages.length ? "script" : "error", error: st.pages.length ? undefined : "Interrupted while writing. Write it again." });
        st.assessing = undefined;
        if (st.status === "illustrating" || st.status === "rendering") st.status = "pages";
        this.stories.set(st.id, st);
      }
    }
    // anything the assessor never got to (capy closed mid-way) is assessed now
    for (const st of this.stories.values()) {
      if (st.status === "script" && st.pages.length && !st.assessments?.script) this.assessor.add({ id: st.id, stage: "script" });
      if (st.status === "done" && st.video && !st.assessments?.video) this.assessor.add({ id: st.id, stage: "video" });
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
        // drawn and rendered beside the old one, which stays until the new drawing is known to render
        const svg = await this.deps.drawCharacter(s, c, ai);
        const svgFile = path.join(dir, `${c.id}.new.svg`);
        const png = path.join(dir, `${c.id}.png`);
        await writeFile(svgFile, characterCard(svg));
        await this.deps.rasterize(svgFile, path.join(dir, `${c.id}.new.png`));
        await rename(svgFile, path.join(dir, `${c.id}.svg`));
        await rename(path.join(dir, `${c.id}.new.png`), png);
        Object.assign(c, { svg, status: "ready", error: undefined, imageUrl: `${toMediaUrl(png)}?v=${Date.now()}` });
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
    const st: StoryState = { id: newId("st"), seriesId, title: "Planning…", brief: brief.trim(), moral: "", status: "planning", pages: [], log: [], createdAt: now, updatedAt: now };
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
      Object.assign(st, next, { review: undefined, video: undefined, contentReview: undefined, publish: undefined, seo: undefined, queuedAt: undefined, assessments: undefined });
      this.log(st, notes.length ? "Rewritten with your notes" : "Written again");
      st.status = "script";
      st.review = await this.tryReview(st, s, ai);
      this.assess(st, "script");
    });
    return st;
  }

  private async writeAndReview(st: StoryState, s: StorySeries) {
    const ai = await this.deps.ai();
    // planned for reach first: what parents search, the hook, the shape; a failed plan just means writing from the brief
    try {
      st.plan = await this.deps.plan(s, st.brief, ai);
      st.title = storyName(st.plan.title);
      this.log(st, `Planned for "${st.plan.keyword}": ${st.plan.pages} pages, ~${st.plan.targetSeconds}s`);
    } catch (e) {
      this.log(st, `Couldn't plan it (${errText(e)}); writing from the idea alone`);
    }
    st.status = "writing";
    await this.saveStory(st);
    Object.assign(st, await this.deps.writeStory(s, st.brief, ai, st.plan));
    this.log(st, `Written: ${st.pages.length} pages`);
    st.status = "script";
    let review = await this.tryReview(st, s, ai);
    if (review?.verdict === "fix" && review.notes.length) {
      // one automatic round with the reviewer's notes; anything left is for the user
      this.log(st, `Reviewer asked for changes: ${review.notes.join(" · ")}`);
      Object.assign(st, await this.deps.reviseStory(s, st, review.notes, ai));
      review = await this.tryReview(st, s, ai);
    }
    st.review = review;
    this.assess(st, "script");
  }

  /** The story reviewer's verdict, or undefined (logged) if it couldn't run: the script waits for a recheck. */
  private async tryReview(st: StoryState, s: StorySeries, ai: AiOpts) {
    try {
      const review = await this.deps.reviewStory(s, st, ai);
      this.log(st, `Story reviewer: ${review.verdict}`);
      return review;
    } catch (e) {
      this.log(st, `The story reviewer couldn't check it (${errText(e)}). Check it again before approving.`);
      return undefined;
    }
  }

  /** Run the story reviewer again on the current words (after it failed, or after the user's own edits). */
  async recheck(id: string) {
    const { st, s } = this.ready(id, ["script", "pages", "done"]);
    const prev = st.status;
    st.status = "writing";
    await this.saveStory(st);
    void this.task(st, async () => {
      st.review = await this.tryReview(st, s, await this.deps.ai());
      st.status = prev;
      this.assess(st, "script");
    });
    return st;
  }

  /** Run the assessor again on the story's current stage (after it failed, or to get a fresh look). */
  async reassess(id: string) {
    const { st } = this.ready(id, ["script", "pages", "done"]);
    if (!st.pages.length) throw new Error("Write the story first");
    this.assess(st, st.status === "done" && st.video ? "video" : "script");
    return st;
  }

  // ---------- the assessor ----------

  /** Ask the assessor to look at a stage; the old verdict for that stage is dropped right away. */
  private assess(st: StoryState, stage: StoryAssessment["stage"]) {
    if (st.assessments?.[stage]) st.assessments = { ...st.assessments, [stage]: undefined };
    this.assessor.add({ id: st.id, stage });
  }

  private async runAssessment({ id, stage }: AssessJob) {
    const st = this.stories.get(id);
    const s = st && this.series.get(st.seriesId);
    if (!st || !s || !st.pages.length || (stage === "video" && !st.video)) return;
    const key = stage === "script" ? wordsKey(st) : String(st.video?.renderedAt);
    st.assessing = stage;
    await this.saveStory(st);
    let a: StoryAssessment;
    try {
      a = await this.deps.assess(s, st, stage, await this.deps.ai());
    } catch (e) {
      a = { stage, at: Date.now(), overall: 0, scores: { hook: 0, retention: 0, search: 0, safety: 0, production: 0 }, verdict: "fix", strengths: [], fixes: [], error: errText(e) };
    }
    if (!this.stories.has(id)) return; // deleted meanwhile
    st.assessing = undefined;
    // the words (or the video) changed while it looked: that change queued a fresh assessment
    if ((stage === "script" ? wordsKey(st) : String(st.video?.renderedAt)) === key) {
      st.assessments = { ...st.assessments, [stage]: a };
      this.log(st, a.error ? `Assessor couldn't run: ${a.error}` : `Assessor (${stage}): ${a.overall}/100, ${a.verdict}`);
    }
    await this.saveStory(st);
  }

  /** The user's edits to the script. A changed scene or cast means that page's picture is drawn again. */
  async updateStory(id: string, patch: { title?: string; pages?: Pick<StoryPage, "text" | "scene" | "cast">[] }) {
    const { st } = this.ready(id, ["script", "pages", "done"]);
    const before = wordsKey(st);
    if (patch.title?.trim() && patch.title.trim() !== st.title) {
      st.title = patch.title.trim();
      if (st.status === "done") st.status = "pages"; // the title card shows the old one
    }
    if (patch.pages) {
      st.pages = patch.pages.map((p, i) => {
        const old = st.pages[i];
        const same = old && old.scene === p.scene && JSON.stringify(old.cast) === JSON.stringify(p.cast);
        return { ...(old ?? {}), text: p.text.trim(), scene: p.scene.trim(), cast: p.cast, status: same ? old!.status : "pending", ...(same ? {} : { imageUrl: undefined }) };
      });
      if (st.status === "done") st.status = "pages"; // the video no longer matches the words
    }
    if (wordsKey(st) !== before) {
      st.assessments = undefined; // it was about the old words
      this.assess(st, "script");
    }
    await this.saveStory(st);
    return st;
  }

  // ---------- story: pictures ----------

  async approveScript(id: string) {
    const { st, s } = this.ready(id, ["script", "pages", "done"]);
    if (!st.pages.length) throw new Error("The story has no pages");
    if (!st.review) throw Object.assign(new Error("The story reviewer hasn't checked this story yet. Check it first."), { status: 409 });
    if (st.review.verdict === "block") throw Object.assign(new Error("The story reviewer blocked this story. Rewrite it first."), { status: 409 });
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
    if (s.characters.some((c) => c.status !== "ready")) throw Object.assign(new Error("Wait for the characters to be drawn (or draw the failed ones again)"), { status: 409 });
    st.status = "rendering";
    st.voice = voice;
    if (st.assessments?.video) st.assessments = { ...st.assessments, video: undefined };
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
      // made beside the current video and swapped in only once it all worked, so a failure leaves the old one whole
      const out = path.join(dir, `${base}.mp4`);
      const tmp = path.join(dir, `${base}.tmp.mp4`);
      const { duration } = await this.deps.assemble({
        pages: st.pages.map((_, i) => path.join(dir, "pages", `${pad2(i + 1)}.png`)),
        narration,
        starts: tl.starts,
        total: tl.total,
        words: tl.words,
        title: st.title,
        lead: LEAD,
        assFile: path.join(dir, "story.ass"),
        out: tmp,
      });
      const jpg = path.join(dir, `${base}.jpg`);
      const tmpJpg = path.join(dir, `${base}.tmp.jpg`);
      const hasCover = await this.deps.cover(tmp, tmpJpg).then(() => existsSync(tmpJpg), () => false);
      const old = st.video?.file;
      await rename(tmp, out);
      if (hasCover) await rename(tmpJpg, jpg);
      else await rm(jpg, { force: true });
      if (old && old !== out) await rm(old, { force: true }).then(() => rm(old.replace(/\.mp4$/, ".jpg"), { force: true }));
      const renderedAt = Date.now();
      st.video = { url: `${toMediaUrl(out)}?v=${renderedAt}`, file: out, duration, coverUrl: hasCover ? `${toMediaUrl(jpg)}?v=${renderedAt}` : undefined, renderedAt };
      this.log(st, `Rendered ${Math.round(duration)}s with ${voice}`);
      const ai = await this.deps.ai();
      const draft = await this.deps.storyPublish(s, st, ai).catch(() => ({ ytTitle: `${st.title} | Bedtime Story #shorts`.slice(0, 100), description: st.moral, hashtags: ["bedtimestory", "kidsstories", "readaloud", "shorts"] }));
      // search-tuned for what parents type; the kids content review below then checks the final text
      // the planned search title is the upload title (the story keeps its short name for the title card)
      if (st.plan?.title && `${st.plan.title} #shorts`.length <= 100) draft.ytTitle = `${st.plan.title} #shorts`;
      const seeds = st.plan?.keyword ? [st.plan.keyword, ...st.plan.searchTerms.slice(0, 2)] : undefined;
      const tuned = await this.deps.tuneSeo({ kind: "kids", publish: draft, seeds, about: `${st.title}. Ages ${s.ageBand}. Length: ${Math.round(duration)} seconds (say so truthfully if the length is mentioned). Moral: ${st.moral}. ${st.pages.map((p) => p.text).join(" ")}` }, ai);
      st.publish = tuned.publish;
      st.seo = tuned.seo;
      this.log(st, `SEO ${tuned.seo.score}${tuned.seo.keyword ? ` for "${tuned.seo.keyword}"` : ""}`);
      st.contentReview = await this.deps.reviewContent(
        { profile: "kids", videoTitle: s.title, clipTitle: st.title, hook: st.title, transcript: st.pages.map((p) => p.text).join(" "), ytTitle: st.publish.ytTitle, caption: st.publish.description, hashtags: st.publish.hashtags },
        ai,
      );
      this.log(st, `AI review: ${st.contentReview.verdict}`);
      st.queuedAt = undefined;
      st.status = "done";
      this.assess(st, "video");
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
          fp: storyFp(st),
          link: `/stories/${st.seriesId}/${st.id}`,
          clipTitle: st.title,
          videoTitle: s.title,
          videoUrl: st.video!.url,
          thumbUrl: st.video!.coverUrl,
          thumbAt: 0.8,
          publish: st.publish,
          hook: st.title,
          aiReview: st.contentReview,
          seo: st.seo,
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
    if (this.busy.has(id) || ["planning", "writing", "illustrating", "rendering"].includes(st.status)) throw busyError();
    this.stories.delete(id);
    // a queued copy would point at a file that's gone
    queue().mutate((e) => e.filter((x) => x.jobId !== `story-${id}`));
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
    await saveJsonAtomic(path.join(this.seriesDir(s.id), "series.json"), s);
  }

  private async saveStory(st: StoryState) {
    st.updatedAt = Date.now();
    await saveJsonAtomic(path.join(this.storyDir(st), "story.json"), st);
  }
}

/** Identity of a story's current video: every render is a new cut, even one of the same length. */
export function storyFp(st: StoryState): string {
  return st.video?.renderedAt ? `r${st.video.renderedAt}` : fingerprint(0, st.video?.duration ?? 0);
}

/** The file the poster posts for a story's queue entry; "changed" if it was re-rendered after the approval. */
export function storyClipFile(st: StoryState | undefined, e: { fp?: string }, exists: (f: string) => boolean = existsSync): { file: string; thumbFile?: string } | "missing" | "changed" | "rendering" {
  if (st?.status === "rendering") return "rendering"; // the mp4 is being rewritten: post it on a later tick
  if (!st?.video || !exists(st.video.file)) return "missing";
  if (e.fp && storyFp(st) !== e.fp) return "changed";
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
