import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

vi.hoisted(() => {
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const p = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-stories-"));
  process.env.CAPY_OUTPUT = p.join(root, "out");
  process.env.CAPY_DATA_DIR = p.join(root, "data");
});

import { saveJsonAtomic, StoryManager, storyClipFile, storyFp, type StoryDeps } from "../server/stories";
import { saveAccount, resetAccountsCache } from "../server/accounts";
import { queue, resetQueueCache } from "../server/queue";
import type { StoryState } from "../lib/types";

const page = (text: string, cast = [{ id: "pip", x: 0.5 }]) => ({ text, scene: "snowy hill", cast, status: "pending" as const });

function fakes(over: Partial<StoryDeps> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const track =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...a: A): R => {
      (calls[name] ??= []).push(a);
      return fn(...a);
    };
  const deps: StoryDeps = {
    ai: async () => ({ agent: "claude" }),
    drawCharacter: track("drawCharacter", async () => '<circle r="50"/>'),
    writeStory: track("writeStory", async () => ({ title: "Pip Shares", moral: "Sharing", pages: [page("Pip had a sled."), page("Lulu wanted a turn.")] })),
    reviewStory: track("reviewStory", async () => ({ verdict: "ok" as const, notes: [] })),
    reviseStory: track("reviseStory", async () => ({ title: "Pip Shares", moral: "Sharing", pages: [page("Pip had a sled."), page("Lulu asked nicely.")] })),
    drawBackground: track("drawBackground", async () => '<rect width="1080" height="1920" fill="#cde"/>'),
    rasterize: track("rasterize", async (_svg: string, png: string) => void writeFileSync(png, "png")),
    narrate: track("narrate", async (_t: string, _v: string, out: string) => (writeFileSync(out, "aiff"), 2)),
    assemble: track("assemble", async (o: { out: string; total: number }) => (writeFileSync(o.out, "mp4"), { duration: o.total + 1.2 })),
    cover: track("cover", async (_mp4: string, jpg: string) => void writeFileSync(jpg, "jpg")),
    reviewContent: track("reviewContent", async () => ({ verdict: "ok" as const, summary: "Lovely", issues: [], at: 1 })),
    tuneSeo: track("tuneSeo", async (i: { publish: { ytTitle: string; description: string; hashtags: string[] } }) => ({
      publish: { ...i.publish, ytTitle: `Bedtime Story: ${i.publish.ytTitle}`, tags: ["bedtime story"] },
      seo: { score: 88, before: 40, keyword: "bedtime story", checks: [], at: 1 },
    })),
    storyPublish: track("storyPublish", async () => ({ ytTitle: "Pip Shares #shorts", description: "A story about sharing.", hashtags: ["bedtimestory"] })),
    plan: track("plan", async () => ({
      keyword: "bedtime story for toddlers",
      searchTerms: ["sharing story"],
      title: "Pip Shares | Bedtime Story for Toddlers",
      hook: { line: "Pip had a brand-new sled!", picture: "a red sled" },
      beats: { setup: "a", problem: "b", turn: "c", ending: "d" },
      pages: 7,
      targetSeconds: 45,
      parentsWhy: "sharing",
      at: 1,
    })),
    assess: track("assess", async (_s: unknown, _st: unknown, stage: "script" | "video") => ({
      stage,
      at: 1,
      overall: 81,
      scores: { hook: 80, retention: 80, search: 80, safety: 100, production: 60 },
      verdict: "ready" as const,
      strengths: ["Warm opening"],
      fixes: [],
    })),
    ...over,
  };
  return { deps, calls };
}

const until = async (fn: () => boolean) => vi.waitFor(() => expect(fn()).toBe(true), { timeout: 5000 });
const newSeries = (m: StoryManager) => m.createSeries({ title: "Pip & Lulu", ageBand: "2-4", tone: "gentle", values: ["sharing"], artStyle: "flat", characters: [{ name: "Pip", description: "a penguin" }, { name: "Lulu", description: "a seal" }] });

beforeEach(() => {
  resetQueueCache();
  resetAccountsCache();
});

describe("StoryManager", () => {
  it("creates a series and draws each character once", async () => {
    const { deps, calls } = fakes();
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    expect(s.characters.map((c) => c.id)).toEqual(["pip", "lulu"]);
    await until(() => m.getSeries(s.id)!.characters.every((c) => c.status === "ready"));
    expect(calls.drawCharacter).toHaveLength(2);
    expect(m.getSeries(s.id)!.characters[0]!.imageUrl).toMatch(/^\/api\/media\/stories\/.+\/chars\/pip\.png/);
  });

  it("writes a story, revises it once when the reviewer asks, and stops at the script for the user", async () => {
    let reviews = 0;
    const { deps, calls } = fakes({ reviewStory: async () => (reviews++ === 0 ? { verdict: "fix" as const, notes: ["Page 2: make Lulu ask nicely"] } : { verdict: "ok" as const, notes: [] }) });
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    const st = await m.createStory(s.id, "Pip learns to share");
    await until(() => m.getStory(st.id)!.status === "script");
    const done = m.getStory(st.id)!;
    expect(calls.reviseStory![0]![2]).toEqual(["Page 2: make Lulu ask nicely"]);
    expect(done.pages[1]!.text).toBe("Lulu asked nicely.");
    expect(done.review).toEqual({ verdict: "ok", notes: [] });
  });

  it("illustrates every page after the script is approved, with the series' characters on it", async () => {
    const { deps, calls } = fakes();
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    await until(() => m.getSeries(s.id)!.characters.every((c) => c.status === "ready"));
    const st = await m.createStory(s.id, "x");
    await until(() => m.getStory(st.id)!.status === "script");
    await m.approveScript(st.id);
    await until(() => m.getStory(st.id)!.status === "pages");
    expect(calls.drawBackground).toHaveLength(2);
    const svg = readFileSync(path.join(m.storyDir(m.getStory(st.id)!), "pages", "01.svg"), "utf8");
    expect(svg).toContain('<g id="char-pip"><circle r="50"/></g>');
    expect(m.getStory(st.id)!.pages.every((p) => p.status === "ready" && p.imageUrl)).toBe(true);
  });

  it("narrates, renders, reviews (kids profile) and writes the parent-facing text", async () => {
    const { deps, calls } = fakes();
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    await until(() => m.getSeries(s.id)!.characters.every((c) => c.status === "ready"));
    const st = await m.createStory(s.id, "x");
    await until(() => m.getStory(st.id)!.status === "script");
    await m.approveScript(st.id);
    await until(() => m.getStory(st.id)!.status === "pages");
    await m.render(st.id, "Samantha");
    await until(() => m.getStory(st.id)!.status === "done");
    const done = m.getStory(st.id)!;
    expect(calls.narrate).toHaveLength(2);
    expect(calls.narrate![0]![1]).toBe("Samantha");
    const a = calls.assemble![0]![0] as { starts: number[]; title: string; lead: number };
    expect(a.title).toBe("Pip Shares");
    expect(a.starts[0]).toBe(a.lead);
    expect(done.video!.url).toMatch(/\.mp4\?v=/);
    expect(calls.reviewContent![0]![0]).toMatchObject({ profile: "kids", clipTitle: "Pip Shares" });
    // the upload text is search-tuned before the kids review, and the reviewer sees the tuned text
    // the planned search title is the upload title; then it's search-tuned; then the kids reviewer sees the tuned text
    expect(calls.tuneSeo![0]![0]).toMatchObject({ kind: "kids", publish: { ytTitle: "Pip Shares | Bedtime Story for Toddlers #shorts" } });
    expect(done.publish).toMatchObject({ ytTitle: "Bedtime Story: Pip Shares | Bedtime Story for Toddlers #shorts", tags: ["bedtime story"] });
    expect(done.seo).toMatchObject({ score: 88, before: 40 });
    expect(calls.reviewContent![0]![0]).toMatchObject({ ytTitle: "Bedtime Story: Pip Shares | Bedtime Story for Toddlers #shorts" });
  });

  it("draws a page again once when its drawing won't render, then gives up with a clear error", async () => {
    let tries = 0;
    const { deps, calls } = fakes({
      rasterize: async (svg: string, png: string) => {
        if (svg.includes("/pages/") && svg.endsWith("01.svg") && tries++ < 1) throw new Error("rsvg-convert exited with code 1");
        writeFileSync(png, "png");
      },
    });
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    await until(() => m.getSeries(s.id)!.characters.every((c) => c.status === "ready"));
    const st = await m.createStory(s.id, "x");
    await until(() => m.getStory(st.id)!.status === "script");
    await m.approveScript(st.id);
    await until(() => m.getStory(st.id)!.status === "pages");
    expect(m.getStory(st.id)!.pages[0]!.status).toBe("ready");
    expect(calls.drawBackground).toHaveLength(3); // page 1 twice, page 2 once
  });
  it("re-rendering rebuilds every page from its saved background with the characters as they are now", async () => {
    const { deps } = fakes();
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    await until(() => m.getSeries(s.id)!.characters.every((c) => c.status === "ready"));
    const st = await m.createStory(s.id, "x");
    await until(() => m.getStory(st.id)!.status === "script");
    await m.approveScript(st.id);
    await until(() => m.getStory(st.id)!.status === "pages");
    const dir = path.join(m.storyDir(m.getStory(st.id)!), "pages");
    expect(existsSync(path.join(dir, "01.bg.svg"))).toBe(true);
    // Pip is redrawn after the pages were made: the next render uses the new Pip without drawing any page again
    m.getSeries(s.id)!.characters[0]!.svg = '<rect id="new-pip"/>';
    await m.render(st.id, "Samantha");
    await until(() => m.getStory(st.id)!.status === "done");
    expect(readFileSync(path.join(dir, "01.svg"), "utf8")).toContain('<rect id="new-pip"/>');
  });
  it("refuses a second action while the story is busy", async () => {
    let release!: () => void;
    const { deps } = fakes({ writeStory: () => new Promise((r) => (release = () => r({ title: "T", moral: "M", pages: [page("Hi.")] }))) });
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    const st = await m.createStory(s.id, "x");
    await expect(m.approveScript(st.id)).rejects.toMatchObject({ status: 409 });
    await until(() => typeof release === "function"); // the writer starts once the plan is made
    release();
    await until(() => m.getStory(st.id)!.status === "script");
  });

  it("sends a finished story to the review queue as made for kids, once accounts are connected", async () => {
    const { deps } = fakes();
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    await until(() => m.getSeries(s.id)!.characters.every((c) => c.status === "ready"));
    const st = await m.createStory(s.id, "x");
    await until(() => m.getStory(st.id)!.status === "script");
    await m.approveScript(st.id);
    await until(() => m.getStory(st.id)!.status === "pages");
    await m.render(st.id, "Samantha");
    await until(() => m.getStory(st.id)!.status === "done");
    await expect(m.sendToQueue(st.id)).rejects.toThrow(/posting account/i);
    saveAccount("youtube", { clientId: "a", clientSecret: "b", tokens: { accessToken: "t", expiresAt: Date.now() + 3600_000 }, account: { id: "c", name: "C" } });
    const n = await m.sendToQueue(st.id);
    expect(n).toBe(1);
    expect(queue().list()[0]).toMatchObject({ jobId: `story-${st.id}`, status: "review", madeForKids: true, clipTitle: "Pip Shares", aiReview: { verdict: "ok" } });
  });

  it("after a restart, interrupted work goes back to a state the user can act on", async () => {
    const { deps } = fakes();
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    const st = await m.createStory(s.id, "x");
    await until(() => m.getStory(st.id)!.status === "script");
    const file = path.join(m.storyDir(m.getStory(st.id)!), "story.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as StoryState;
    writeFileSync(file, JSON.stringify({ ...saved, status: "illustrating", pages: saved.pages.map((p) => ({ ...p, status: "drawing" })) }));
    const fresh = new StoryManager(deps);
    await fresh.init();
    const back = fresh.getStory(st.id)!;
    expect(back.status).toBe("pages");
    expect(back.pages.every((p) => p.status === "pending")).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
});

describe("storyClipFile (what the poster posts for a story entry)", () => {
  const st = { video: { file: "/x/pip.mp4", duration: 41.2, url: "u", coverUrl: "c" } } as unknown as StoryState;
  const entry = (fp?: string) => ({ fp }) as { fp?: string };
  it("returns the video for the approved cut", () => {
    expect(storyClipFile(st, entry("0-412"), () => true)).toEqual({ file: "/x/pip.mp4", thumbFile: "/x/pip.jpg" });
  });
  it("says changed when the story was re-rendered after approval, missing when there's no video", () => {
    expect(storyClipFile(st, entry("0-300"), () => true)).toBe("changed");
    expect(storyClipFile(undefined, entry("0-412"), () => true)).toBe("missing");
    expect(storyClipFile(st, entry("0-412"), () => false)).toBe("missing");
    expect(storyClipFile({ ...st, status: "rendering" } as StoryState, entry("0-412"), () => true)).toBe("rendering");
  });
});

describe("review fixes", () => {
  const made = async (over: Partial<StoryDeps> = {}) => {
    const { deps, calls } = fakes(over);
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    await until(() => m.getSeries(s.id)!.characters.every((c) => c.status !== "drawing"));
    return { m, s, deps, calls };
  };
  const toDone = async (m: StoryManager, seriesId: string) => {
    const st = await m.createStory(seriesId, "x");
    await until(() => m.getStory(st.id)!.status === "script");
    await m.approveScript(st.id);
    await until(() => m.getStory(st.id)!.status === "pages");
    await m.render(st.id, "Samantha");
    await until(() => m.getStory(st.id)!.status === "done");
    return st.id;
  };

  it("a re-render of a queued story (same length) is a new cut: the poster won't post it without a new review", async () => {
    const { m, s } = await made();
    const id = await toDone(m, s.id);
    saveAccount("youtube", { clientId: "a", clientSecret: "b", tokens: { accessToken: "t", expiresAt: Date.now() + 3600_000 }, account: { id: "c", name: "C" } });
    await m.sendToQueue(id);
    const entry = queue().list().find((e) => e.jobId === `story-${id}`)!;
    expect(entry.fp).toBe(storyFp(m.getStory(id)!));
    await new Promise((r) => setTimeout(r, 5));
    await m.render(id, "Samantha");
    await until(() => m.getStory(id)!.status === "done");
    expect(storyClipFile(m.getStory(id), entry, () => true)).toBe("changed");
  });

  it("a failed re-render leaves the previous video and its file untouched", async () => {
    let n = 0;
    const { m, s } = await made({
      assemble: async (o: { out: string; total: number }) => {
        writeFileSync(o.out, n === 0 ? "good mp4" : "half");
        if (n++ > 0) throw new Error("disk full");
        return { duration: o.total + 1.2 };
      },
    });
    const id = await toDone(m, s.id);
    const before = m.getStory(id)!.video!;
    await m.render(id, "Samantha");
    await until(() => m.getStory(id)!.status !== "rendering");
    expect(m.getStory(id)!.video).toEqual(before);
    expect(readFileSync(before.file, "utf8")).toBe("good mp4");
  });

  it("an unreviewed script can't be approved until the reviewer has looked at it", async () => {
    let fail = true;
    const { m, s } = await made({
      reviewStory: async () => {
        if (fail) throw new Error("AI timed out");
        return { verdict: "ok" as const, notes: [] };
      },
    });
    const st = await m.createStory(s.id, "x");
    await until(() => m.getStory(st.id)!.status === "script");
    expect(m.getStory(st.id)!.review).toBeUndefined();
    await expect(m.approveScript(st.id)).rejects.toMatchObject({ status: 409 });
    fail = false;
    await m.recheck(st.id);
    await until(() => !!m.getStory(st.id)!.review);
    await expect(m.approveScript(st.id)).resolves.toBeTruthy();
  });

  it("a rewrite drops the old verdict (it was about the old words)", async () => {
    let reviews = 0;
    const { m, s } = await made({
      reviewStory: async () => {
        if (reviews++ > 0) throw new Error("AI timed out");
        return { verdict: "ok" as const, notes: [] };
      },
    });
    const st = await m.createStory(s.id, "x");
    await until(() => m.getStory(st.id)!.status === "script");
    await m.rewrite(st.id, ["make it rhyme"]);
    await until(() => m.getStory(st.id)!.status === "script");
    expect(m.getStory(st.id)!.review).toBeUndefined();
  });

  it("a character redraw that won't render keeps the previous drawing, and renders wait for the characters", async () => {
    let charRenders = 0;
    const { m, s } = await made({
      rasterize: async (svg: string, png: string) => {
        if (svg.includes("/chars/") && charRenders++ >= 2) throw new Error("rsvg-convert exited with code 1");
        writeFileSync(png, "png");
      },
      drawCharacter: async () => (charRenders >= 2 ? "<broken" : '<circle r="50"/>'),
    });
    const id = await toDone(m, s.id);
    await m.redrawCharacter(s.id, "pip");
    await until(() => m.getSeries(s.id)!.characters[0]!.status === "error");
    expect(m.getSeries(s.id)!.characters[0]!.svg).toBe('<circle r="50"/>');
    await expect(m.render(id, "Samantha")).rejects.toMatchObject({ status: 409 });
  });

  it("changing the title of a finished story asks for a new render (the title card shows the old one)", async () => {
    const { m, s } = await made();
    const id = await toDone(m, s.id);
    await m.updateStory(id, { title: "A New Title" });
    expect(m.getStory(id)!.status).toBe("pages");
  });

  it("deleting a story takes it out of the queue, and isn't allowed mid-step", async () => {
    const { m, s } = await made();
    const id = await toDone(m, s.id);
    saveAccount("youtube", { clientId: "a", clientSecret: "b", tokens: { accessToken: "t", expiresAt: Date.now() + 3600_000 }, account: { id: "c", name: "C" } });
    await m.sendToQueue(id);
    await m.deleteStory(id);
    expect(queue().list().filter((e) => e.jobId === `story-${id}`)).toHaveLength(0);
    const busy = await m.createStory(s.id, "y");
    await expect(m.deleteStory(busy.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("saveJsonAtomic", () => {
  it("leaves valid JSON (the last write) when many saves overlap", async () => {
    const f = path.join(process.env.CAPY_OUTPUT!, "atomic.json");
    await Promise.all(Array.from({ length: 40 }, (_, i) => saveJsonAtomic(f, { i, pad: "x".repeat(i % 2 ? 5000 : 10) })));
    expect(JSON.parse(readFileSync(f, "utf8")).i).toBe(39);
  });
});

describe("plan and assessor", () => {
  const made = async (over: Partial<StoryDeps> = {}) => {
    const { deps, calls } = fakes(over);
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    await until(() => m.getSeries(s.id)!.characters.every((c) => c.status === "ready"));
    return { m, s, calls };
  };

  it("plans before writing: the writer gets the plan, then the assessor looks at the script", async () => {
    const { m, s, calls } = await made();
    const st = await m.createStory(s.id, "Pip learns to share");
    expect(st.status).toBe("planning");
    await until(() => !!m.getStory(st.id)!.assessments?.script);
    const done = m.getStory(st.id)!;
    expect(done.plan!.keyword).toBe("bedtime story for toddlers");
    expect(calls.writeStory![0]![3]).toMatchObject({ title: "Pip Shares | Bedtime Story for Toddlers" });
    expect(m.getStory(st.id)!.title).toBe("Pip Shares"); // the short name; the search title is for the upload
    expect(done.assessments!.script).toMatchObject({ stage: "script", overall: 81, verdict: "ready" });
    expect(done.assessing).toBeUndefined();
  });

  it("a failed plan still writes the story; a failed assessment is recorded, not fatal", async () => {
    const { m, s } = await made({
      plan: async () => {
        throw new Error("AI timed out");
      },
      assess: async () => {
        throw new Error("assessor down");
      },
    });
    const st = await m.createStory(s.id, "x");
    await until(() => !!m.getStory(st.id)!.assessments?.script);
    expect(m.getStory(st.id)!.status).toBe("script");
    expect(m.getStory(st.id)!.plan).toBeUndefined();
    expect(m.getStory(st.id)!.assessments!.script!.error).toBe("assessor down");
  });

  it("editing the words drops the old assessment and assesses again; the video gets its own", async () => {
    const { m, s, calls } = await made();
    const st = await m.createStory(s.id, "x");
    await until(() => !!m.getStory(st.id)!.assessments?.script);
    const pages = m.getStory(st.id)!.pages.map((p) => ({ text: p.text, scene: p.scene, cast: p.cast }));
    pages[0]!.text = "Pip had the shiniest sled!";
    await m.updateStory(st.id, { pages });
    await m.assessor.idle();
    expect(calls.assess).toHaveLength(2);
    // the second look was at the edited words
    expect((calls.assess![1]![1] as { pages: { text: string }[] }).pages[0]!.text).toBe("Pip had the shiniest sled!");
    await m.approveScript(st.id);
    await until(() => m.getStory(st.id)!.status === "pages");
    await m.render(st.id, "Samantha");
    await until(() => !!m.getStory(st.id)!.assessments?.video);
    expect(calls.tuneSeo!.at(-1)![0]).toMatchObject({ seeds: ["bedtime story for toddlers", "sharing story"] });
  });

  it("the assessor works one story at a time", async () => {
    let running = 0;
    let most = 0;
    const { m, s } = await made({
      assess: async (_s, _st, stage) => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { stage, at: 1, overall: 80, scores: { hook: 80, retention: 80, search: 80, safety: 100, production: 60 }, verdict: "ready" as const, strengths: [], fixes: [] };
      },
    });
    const a = await m.createStory(s.id, "a");
    const b = await m.createStory(s.id, "b");
    await until(() => !!m.getStory(a.id)!.assessments?.script && !!m.getStory(b.id)!.assessments?.script);
    expect(most).toBe(1);
  });
});
