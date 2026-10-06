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

import { StoryManager, storyClipFile, type StoryDeps } from "../server/stories";
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
    storyPublish: track("storyPublish", async () => ({ ytTitle: "Pip Shares #shorts", description: "A story about sharing.", hashtags: ["bedtimestory"] })),
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
    expect(done.publish!.ytTitle).toBe("Pip Shares #shorts");
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
  it("refuses a second action while the story is busy", async () => {
    let release!: () => void;
    const { deps } = fakes({ writeStory: () => new Promise((r) => (release = () => r({ title: "T", moral: "M", pages: [page("Hi.")] }))) });
    const m = new StoryManager(deps);
    const s = await newSeries(m);
    const st = await m.createStory(s.id, "x");
    await expect(m.approveScript(st.id)).rejects.toMatchObject({ status: 409 });
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
