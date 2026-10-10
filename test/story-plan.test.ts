import { describe, expect, it } from "vitest";
import { normalizePlan, planPrompt, storyName } from "../src/story/plan";
import { storyWriterPrompt } from "../src/story/write";
import { combineScores, normalizeAssessment, productionScore, safetyScore, searchScore } from "../src/story/assess";
import { tasksFrom } from "../server/tasks";
import type { QueueEntry, StoryAssessment, StorySeries, StoryState } from "../lib/types";

const series: StorySeries = {
  id: "ser1",
  title: "Pip & Lulu",
  ageBand: "2-4",
  tone: "gentle",
  values: ["sharing"],
  artStyle: "pastel",
  characters: [{ id: "pip", name: "Pip", description: "a penguin", status: "ready" }],
  createdAt: 0,
  updatedAt: 0,
};
const page = (text: string) => ({ text, scene: "snowy hill", cast: [{ id: "pip", x: 0.5 }], status: "ready" as const });
const story = (over: Partial<StoryState> = {}): StoryState => ({
  id: "st1",
  seriesId: "ser1",
  title: "Pip Shares",
  brief: "sharing",
  moral: "share",
  status: "script",
  pages: Array.from({ length: 7 }, (_, i) => page(`Pip slides down the hill number ${i + 1}. Whee!`)),
  log: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});
const assessment = (over: Partial<StoryAssessment> = {}): StoryAssessment => ({
  stage: "script",
  at: 5,
  overall: 82,
  scores: { hook: 80, retention: 80, search: 80, safety: 100, production: 80 },
  verdict: "ready",
  strengths: [],
  fixes: [],
  ...over,
});

describe("story plan", () => {
  it("normalises the planner's answer and keeps pages and length in the age band", () => {
    const p = normalizePlan(
      {
        keyword: " Bedtime Story for Toddlers ",
        searchTerms: ["sharing story for kids", "", "toddler bedtime story", 3],
        title: "Pip Learns to Share | Bedtime Story for Toddlers",
        hook: { line: "Pip had a brand-new red sled!", picture: "Pip hugging a shiny red sled on a sparkling hill" },
        beats: { setup: "new sled", problem: "won't share", turn: "Lulu is sad", ending: "they ride together, Whee!" },
        refrain: "Whee, down we go!",
        pages: 14,
        targetSeconds: 300,
        parentsWhy: "A calm sharing lesson",
      },
      series,
    );
    expect(p.keyword).toBe("bedtime story for toddlers");
    expect(p.searchTerms).toEqual(["sharing story for kids", "toddler bedtime story"]);
    expect(p.pages).toBe(8);
    expect(p.targetSeconds).toBe(60);
    expect(p.refrain).toBe("Whee, down we go!");
    expect(() => normalizePlan({ keyword: "x" }, series)).toThrow(/plan/);
  });

  it("the planner sees the research; the writer follows the plan", () => {
    const prompt = planPrompt(series, "Pip learns to share", {
      rawVersion: 1,
      seed: "bedtime story",
      keywords: [{ term: "bedtime story for toddlers", score: 80, sources: ["autocomplete"] }],
      ranking: [{ id: "r", title: "Calm Bedtime Stories for Kids", channel: "X", views: 1000 }],
      tags: [],
      notes: [],
      at: 0,
    });
    expect(prompt).toContain("bedtime story for toddlers");
    expect(prompt).not.toMatch(/score 80|best first/);
    expect(prompt).toContain("Calm Bedtime Stories for Kids");
    expect(prompt).toMatch(/never.*children/i);
    const w = storyWriterPrompt(series, "Pip learns to share", {
      keyword: "bedtime story for toddlers",
      searchTerms: [],
      title: "Pip Learns to Share",
      hook: { line: "Pip had a brand-new red sled!", picture: "a shiny red sled" },
      beats: { setup: "a", problem: "b", turn: "c", ending: "d" },
      refrain: "Whee, down we go!",
      pages: 7,
      targetSeconds: 45,
      parentsWhy: "",
      at: 0,
    });
    expect(w).toContain("Pip had a brand-new red sled!");
    expect(w).toContain("Whee, down we go!");
    expect(w).toContain("7 pages");
    expect(w).toMatch(/Title: Pip Learns to Share/);
    expect(storyName("Pip & Lulu and the Stars | Bedtime Story for Toddlers")).toBe("Pip & Lulu and the Stars");
    expect(storyName("Pip's Big Day")).toBe("Pip's Big Day");
  });
});

describe("assessor scoring", () => {
  it("production: pages in the band, words per page, and at video stage the length and pictures", () => {
    expect(productionScore(story(), series, "script")).toBe(100);
    expect(productionScore(story({ pages: [page("one"), page("two")] }), series, "script")).toBeLessThan(70);
    const wordy = story({ pages: Array.from({ length: 7 }, () => page("word ".repeat(30))) });
    expect(productionScore(wordy, series, "script")).toBeLessThanOrEqual(60);
    const long = story({ status: "done", video: { url: "", file: "", duration: 140 } });
    expect(productionScore(long, series, "video")).toBe(90); // too long (-10), every page drawn
  });

  it("safety: the stricter of the story reviewer and the content reviewer", () => {
    expect(safetyScore(story({ review: { verdict: "ok", notes: [] } }), "script")).toBe(100);
    expect(safetyScore(story({ review: { verdict: "fix", notes: ["x"] } }), "script")).toBe(60);
    expect(safetyScore(story({ review: { verdict: "ok", notes: [] }, contentReview: { verdict: "block", summary: "", issues: [], at: 0 } }), "video")).toBe(0);
    expect(safetyScore(story(), "script")).toBe(50);
  });

  it("search: the planned title at script stage, the tuned upload text at video stage", () => {
    const planned = story({ plan: { keyword: "bedtime story for toddlers", title: "Bedtime Story for Toddlers: Pip Shares" } as StoryState["plan"] });
    expect(searchScore(planned, "script")).toBe(100);
    expect(searchScore(story({ seo: { score: 64, checks: [], at: 0 } }), "video")).toBe(64);
  });

  it("overall and verdict", () => {
    expect(combineScores({ hook: 90, retention: 80, search: 70, safety: 100, production: 100 })).toEqual({ overall: 87, verdict: "ready" });
    expect(combineScores({ hook: 90, retention: 90, search: 90, safety: 60, production: 90 }).verdict).toBe("fix");
    expect(combineScores({ hook: 100, retention: 100, search: 100, safety: 0, production: 100 }).verdict).toBe("block");
  });

  it("clamps the AI's judgement and drops empty notes", () => {
    const a = normalizeAssessment({ hook: { score: 130 }, retention: { score: "x" }, strengths: ["Great refrain", ""], fixes: [{ area: "hook", note: "Open on the sled" }, { area: "x" }] });
    expect(a).toEqual({ hook: 100, retention: 50, strengths: ["Great refrain"], fixes: [{ area: "hook", note: "Open on the sled" }] });
  });
});

describe("To do", () => {
  const entry = (n: number, status: QueueEntry["status"]): QueueEntry => ({ key: `j:${n}:youtube`, jobId: "j", n, platform: "youtube", status, clipTitle: "c", text: {}, attempts: 0, history: [], createdAt: 0, updatedAt: 0 });

  it("hands a script over only once the assessor has looked at it", () => {
    expect(tasksFrom([story()], [series], [])).toEqual([]);
    const t = tasksFrom([story({ assessments: { script: assessment() } })], [series], []);
    expect(t).toMatchObject([{ kind: "script", href: "/stories/ser1/st1", tone: "action", overall: 82 }]);
    expect(t[0]!.title).toMatch(/Review the script/);
    const blocked = tasksFrom([story({ assessments: { script: assessment({ verdict: "block", fixes: [{ area: "safety", note: "Sledding alone" }] }) } })], [series], []);
    expect(blocked[0]).toMatchObject({ kind: "fix", tone: "block" });
    expect(blocked[0]!.detail).toContain("Sledding alone");
  });

  it("covers pictures, finished videos, errors and the queue", () => {
    const t = tasksFrom(
      [
        story({ id: "a", status: "pages" }),
        story({ id: "b", status: "done", video: { url: "", file: "", duration: 40 }, assessments: { video: assessment({ stage: "video" }) } }),
        story({ id: "c", status: "done", video: { url: "", file: "", duration: 40 }, assessments: { video: assessment({ stage: "video", verdict: "fix", fixes: [{ area: "search", note: "No keyword in title" }] }) } }),
        story({ id: "d", status: "done", queuedAt: 1, video: { url: "", file: "", duration: 40 }, assessments: { video: assessment({ stage: "video" }) } }),
        story({ id: "e", status: "error", error: "Interrupted" }),
      ],
      [series],
      [entry(1, "review"), entry(2, "review"), entry(3, "scheduled")],
    );
    expect(t.map((x) => x.kind).sort()).toEqual(["error", "fix", "pictures", "queue", "send"]);
    expect(t.find((x) => x.kind === "queue")!.title).toMatch(/2 videos/);
    expect(t.find((x) => x.kind === "send")!.title).toMatch(/send it to Queue/);
  });
});
