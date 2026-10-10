import { beforeEach, describe, expect, it, vi } from "vitest";

// the data folder resolves at import: point it at a temp folder first
vi.hoisted(() => {
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const p = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-similarity-"));
  process.env.CAPY_OUTPUT = p.join(root, "out");
  process.env.CAPY_DATA_DIR = p.join(root, "data");
});

import {
  mergeOpinions,
  nearDuplicateClusters,
  normalizeVerdicts,
  prePass,
  similarityCandidates,
  similarityGroups,
  looksSimilar,
  type ClipFacts,
  type ClipSimilarity,
  type SimilarityOpinion,
} from "../lib/similarity";
import { DEFAULT_AI_ROUTING, resolveAiTask } from "../lib/ai-policy";
import type { JobState, QueueEntry } from "../lib/types";
import { runtimeStore } from "../server/db/runtime";
import { publicQueueEntry } from "../server/queue";
import {
  SIMILARITY_STORE,
  buildSimilarityPrompt,
  clipFacts,
  requestSimilarityCheck,
  routingFor,
  runSimilarityCheck,
  similaritySetHash,
  similaritySweep,
  storedSimilarity,
  unavailableReason,
  type SimilarityAsk,
} from "../server/similarity";

const NOW = Date.UTC(2026, 9, 11, 12);
const DAY = 86_400_000;

const facts = (id: string, over: Partial<ClipFacts> = {}): ClipFacts => ({
  id,
  state: "waiting",
  title: id,
  at: NOW,
  link: `/x/${id}`,
  ...over,
});

// the owner's case: four clips cut from one IShowSpeed NBA 2K stream
const speed = (n: number, title: string, start: number, over: Partial<ClipFacts> = {}) =>
  facts(`speed:${n}`, {
    title,
    source: "yt:speed2k",
    videoTitle: "IShowSpeed plays NBA 2K for $500",
    channel: "IShowSpeed",
    start,
    end: start + 45,
    ...over,
  });
const SPEED = [
  speed(1, "$500 2K wager", 600),
  speed(2, "Gets Raided Mid-Wager", 1800),
  speed(3, "Goes Up in $500 2K Wager", 3000),
  speed(4, "Calls Out Rival", 4200),
];
const garden = facts("garden:1", {
  title: "How to repot a cactus without gloves",
  source: "yt:garden",
  channel: "Plant Dad",
  start: 10,
  end: 50,
});

describe("pre-pass", () => {
  it("flags clips from the same source video, with or without similar titles", () => {
    const close = prePass(SPEED[0]!, SPEED[2]!);
    expect(close.reasons).toEqual(["Cut from the same video", "Similar titles"]);
    expect(close.score).toBeGreaterThan(0.7);
    const sameVideoOnly = prePass(SPEED[1]!, SPEED[3]!);
    expect(sameVideoOnly.reasons).toEqual(["Cut from the same video"]);
    expect(sameVideoOnly.score).toBeGreaterThanOrEqual(0.35);
  });
  it("notices overlapping footage and nearby moments", () => {
    const a = speed(5, "Speed screams", 100);
    expect(prePass(a, speed(6, "Different words", 110)).reasons).toContain("Uses the same part of the video");
    expect(prePass(a, speed(7, "Different words", 200)).reasons).toContain("From moments close together in the video");
  });
  it("matches similar titles across different videos, and skips unrelated clips", () => {
    const other = facts("speed-b:1", { title: "Speed's $500 NBA 2K wager goes wrong", source: "yt:other", channel: "IShowSpeed" });
    const c = prePass(SPEED[0]!, other);
    expect(c.reasons).toEqual(["Similar titles", "Same creator"]);
    expect(prePass(SPEED[0]!, garden).score).toBeLessThan(0.35);
    expect(similarityCandidates(garden, SPEED)).toEqual([]);
  });
  it("groups the four stream clips together and leaves the unrelated clip alone (no AI needed)", () => {
    const posted = facts("old:1", { state: "posted", title: "Repotting succulents", source: "yt:p" });
    const { groups, alone } = similarityGroups([...SPEED, garden, posted]);
    expect(alone).toEqual(["garden:1"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.waiting).toEqual(SPEED.map((f) => f.id));
    expect(groups[0]!.candidates["speed:1"]!.map((c) => c.id)).toContain("speed:3");
  });
  it("brings scheduled and posted look-alikes into the group but never asks for their verdict", () => {
    const scheduled = speed(9, "$500 2K wager part 2", 5000, { state: "scheduled" });
    const { groups } = similarityGroups([SPEED[0]!, scheduled]);
    expect(groups[0]).toMatchObject({ waiting: ["speed:1"], members: ["speed:1", "speed:9"] });
  });
  it("splits a very large cluster so each prompt stays small", () => {
    const many = Array.from({ length: 11 }, (_, i) => speed(20 + i, `Wager clip ${i}`, i * 300));
    const { groups } = similarityGroups(many, { waiting: 8, others: 6 });
    expect(groups.map((g) => g.waiting.length)).toEqual([8, 3]);
  });
});

describe("AI answers", () => {
  const labels = { C1: "speed:1", C2: "speed:2", C3: "garden:1" };
  it("maps labels back to clips and drops self, unknown and malformed rows", () => {
    const out = normalizeVerdicts(
      {
        verdicts: [
          { clip: "c1", level: "near-duplicate", similarTo: ["C2", "C1", "C9"], why: " Same  wager. ", recommendation: "Post only 'X'." },
          { clip: "C2", level: "distinct", similarTo: ["C1"], why: "Different moment.", recommendation: "Fine to post." },
          { clip: "C3", level: "similar", similarTo: [], why: "x", recommendation: "y" },
          { clip: "C1", level: "distinct", similarTo: [], why: "dupe row", recommendation: "ignored" },
          { clip: "C2", level: "huge", why: "bad", recommendation: "bad" },
        ],
      },
      labels,
      ["speed:1", "speed:2"],
      "codex",
    );
    expect(out).toEqual({
      "speed:1": { by: "codex", level: "near-duplicate", similarTo: ["speed:2"], why: "Same wager.", recommendation: "Post only 'X'." },
      "speed:2": { by: "codex", level: "distinct", similarTo: [], why: "Different moment.", recommendation: "Fine to post." },
    });
    expect(normalizeVerdicts("nonsense", labels, ["speed:1"], "claude")).toEqual({});
  });

  const op = (by: "claude" | "codex", level: SimilarityOpinion["level"], similarTo: string[] = ["b"]): SimilarityOpinion => ({
    by,
    level,
    similarTo: level === "distinct" ? [] : similarTo,
    why: `${by} why`,
    recommendation: `${by} says`,
  });
  it("merges two agreeing opinions", () => {
    expect(mergeOpinions([op("claude", "near-duplicate", ["b"]), op("codex", "near-duplicate", ["b", "c"])])).toEqual({
      level: "near-duplicate",
      agreement: "agree",
      similarTo: ["b", "c"],
      why: "claude why",
      recommendation: "claude says",
    });
  });
  it("lets the more cautious opinion lead when they disagree", () => {
    expect(mergeOpinions([op("claude", "distinct"), op("codex", "similar")])).toMatchObject({
      level: "similar",
      agreement: "differ",
      recommendation: "codex says",
    });
  });
  it("uses the one opinion when the other AI is missing", () => {
    expect(mergeOpinions([op("claude", "similar")])).toMatchObject({ level: "similar", agreement: "single" });
  });
  it("says unchecked when nobody answered but clips looked close, distinct when nothing was close", () => {
    expect(mergeOpinions([], true)).toEqual({ level: "unchecked", agreement: "none", similarTo: [] });
    expect(mergeOpinions([], false)).toEqual({ level: "distinct", agreement: "none", similarTo: [] });
  });
  it("finds clusters of waiting near-duplicates for the hint above the list", () => {
    const rec = (similarTo: string[], level: SimilarityOpinion["level"] = "near-duplicate") =>
      ({ opinions: [{ ...op("claude", level), similarTo }] }) as unknown as ClipSimilarity;
    expect(
      nearDuplicateClusters([
        { id: "a", similarity: rec(["b"]) },
        { id: "b", similarity: rec(["c"]) },
        { id: "c" },
        { id: "d", similarity: rec(["posted:1"]) },
        { id: "e", similarity: rec(["a"], "similar") },
      ]),
    ).toEqual([["a", "b", "c"]]);
  });
});

describe("prompt and routing", () => {
  it("labels clips, marks which need a verdict, and carries the pre-pass reasons", () => {
    const { groups } = similarityGroups(SPEED);
    const { prompt, labels } = buildSimilarityPrompt(SPEED, groups[0]!.candidates);
    expect(labels).toEqual({ C1: "speed:1", C2: "speed:2", C3: "speed:3", C4: "speed:4" });
    expect(prompt).toContain('C1 [WAITING] "$500 2K wager"');
    expect(prompt).toContain("at 10:00-10:45");
    expect(prompt).toContain("cut from the same video");
    expect(prompt).toContain("never by label");
    expect(Buffer.byteLength(prompt)).toBeLessThan(16000);
  });
  it("points the review task at each AI even when Settings route reviews to the other one", () => {
    const base = { ...DEFAULT_AI_ROUTING, tasks: { review: { agent: "claude" as const, model: "claude-haiku-5-5", premium: false } } };
    expect(resolveAiTask("review", { agent: "codex", settings: routingFor("codex", base) })).toMatchObject({ provider: "codex", model: "gpt-6-luna" });
    expect(resolveAiTask("review", { agent: "claude", settings: routingFor("claude", base) })).toMatchObject({ provider: "claude", model: "claude-haiku-5-5" });
    expect(routingFor("codex", base).maxDayRequests).toBe(base.maxDayRequests);
  });
  it("explains a missing opinion in plain words", () => {
    expect(unavailableReason("codex", new Error("Codex is not installed (no `codex` found)"))).toBe("Codex isn't installed on this computer");
    expect(unavailableReason("codex", new Error("AI budget exhausted: today's 40 AI requests are used up (raise it in Settings under AI limits)"))).toBe("today's 40 AI requests are used up");
    expect(unavailableReason("claude", new Error("Claude did not answer within 120s"))).toBe("Claude didn't answer in time");
    expect(unavailableReason("codex", new Error("boom"))).toBe("Codex couldn't answer");
  });
});

// ---------- server: facts, checks, caching ----------

const entry = (jobId: string, n: number, over: Partial<QueueEntry> = {}): QueueEntry => ({
  key: `${jobId}:${n}:youtube`,
  jobId,
  n,
  platform: "youtube",
  status: "review",
  clipTitle: `Clip ${n}`,
  fp: `${n * 6000}-${n * 6000 + 450}`,
  text: { title: `Clip ${n}` },
  attempts: 0,
  history: [],
  createdAt: NOW - 1000 + n,
  updatedAt: NOW,
  ...over,
});

const store = runtimeStore();
const job = {
  id: "speedjob",
  videoId: "speed2k",
  url: "https://youtu.be/speed2k",
  title: "IShowSpeed plays NBA 2K for $500",
  channel: "IShowSpeed",
  dir: "speedjob",
  clips: [1, 2, 3, 4].map((n) => ({ n, start: n * 600, end: n * 600 + 45, title: `Clip ${n}`, hook: `Hook ${n}` })),
} as unknown as JobState;
store.put("legacy-jobs", "speedjob", job);

const queueNow = (): QueueEntry[] => [
  entry("speedjob", 1, { clipTitle: "$500 2K wager" }),
  entry("speedjob", 2, { clipTitle: "Gets Raided Mid-Wager" }),
  entry("speedjob", 3, { clipTitle: "Goes Up in $500 2K Wager" }),
  entry("plants", 1, { clipTitle: "How to repot a cactus without gloves", videoTitle: "Plant care" }),
  entry("speedjob", 4, { clipTitle: "Calls Out Rival", status: "posted", slotAt: NOW - 3 * DAY }),
  entry("oldjob", 1, { clipTitle: "$500 2K wager rerun", status: "posted", slotAt: NOW - 30 * DAY }),
  entry("speedjob", 9, { clipTitle: "Rejected one", status: "rejected" }),
];

/** A fake AI: answers every waiting label as near-duplicate of the others, or fails for one agent. */
function fakeAsk(fail?: "claude" | "codex") {
  const calls: { agent: string; task?: string; review?: string }[] = [];
  const ask: SimilarityAsk = async (agent, prompt, o) => {
    calls.push({ agent, task: o.task, review: o.context?.settings?.tasks.review?.agent });
    if (agent === fail) throw new Error(`${agent === "codex" ? "Codex" : "Claude"} is not installed (no \`${agent}\` found)`);
    const waiting = [...prompt.matchAll(/^(C\d+) \[WAITING\]/gm)].map((m) => m[1]!);
    const data = {
      verdicts: waiting.map((clip) => ({
        clip,
        level: "near-duplicate",
        similarTo: waiting.filter((x) => x !== clip),
        why: `${agent}: same stream, same wager.`,
        recommendation: "Post only the strongest one: '$500 2K wager'; reject the others.",
      })),
    };
    expect(o.validate?.(data)).toBe(true);
    return { data };
  };
  return { ask, calls };
}

describe("similarity check (server)", () => {
  beforeEach(() => {
    for (const id of ["speedjob:1", "speedjob:2", "speedjob:3", "plants:1", "speedjob:4"])
      store.put(SIMILARITY_STORE, id, null);
  });

  it("builds one fact per clip from the queue and the job, leaving out rejected and old posts", () => {
    const f = clipFacts(queueNow(), NOW, store);
    expect(f.map((x) => x.id)).toEqual(["plants:1", "speedjob:1", "speedjob:2", "speedjob:3", "speedjob:4"]);
    expect(f.find((x) => x.id === "speedjob:1")).toMatchObject({
      state: "waiting",
      source: "yt:speed2k",
      channel: "IShowSpeed",
      hook: "Hook 1",
      start: 600,
      end: 645,
      link: "/v/speedjob/clip/1",
    });
    expect(f.find((x) => x.id === "speedjob:4")!.state).toBe("posted");
    // without the job, the time range comes from the entry's fingerprint
    expect(f.find((x) => x.id === "plants:1")).toMatchObject({ start: 600, end: 645, source: "job:plants" });
  });

  it("asks Claude and Codex once each for the whole group, and stores both opinions per waiting clip", async () => {
    const { ask, calls } = fakeAsk();
    await runSimilarityCheck({ targets: ["speedjob:1", "plants:1"] }, { store, ask, entries: queueNow(), now: () => NOW });
    expect(calls.map((c) => c.agent).sort()).toEqual(["claude", "codex"]);
    expect(calls.every((c) => c.task === "review" && c.review === c.agent)).toBe(true);
    const s = storedSimilarity("speedjob:1", store)!;
    expect(s.opinions.map((o) => o.by)).toEqual(["claude", "codex"]);
    expect(s.verdict).toMatchObject({ level: "near-duplicate", agreement: "agree" });
    expect(s.candidates.map((c) => c.id)).toEqual(expect.arrayContaining(["speedjob:2", "speedjob:3", "speedjob:4"]));
    expect(s.candidates.find((c) => c.id === "speedjob:4")).toMatchObject({ state: "posted", title: "Calls Out Rival" });
    expect(s.unavailable).toEqual([]);
    expect(storedSimilarity("speedjob:2", store)!.opinions).toHaveLength(2);
    // nothing close to the plant clip: settled without an AI call
    expect(storedSimilarity("plants:1", store)).toMatchObject({ opinions: [], verdict: { level: "distinct" } });
    expect(looksSimilar(storedSimilarity("plants:1", store))).toBe(false);
  });

  it("shows Claude's opinion alone when Codex is unavailable", async () => {
    const { ask } = fakeAsk("codex");
    await runSimilarityCheck({ targets: ["speedjob:1"] }, { store, ask, entries: queueNow(), now: () => NOW });
    const s = storedSimilarity("speedjob:1", store)!;
    expect(s.opinions.map((o) => o.by)).toEqual(["claude"]);
    expect(s.unavailable).toEqual([{ by: "codex", reason: "Codex isn't installed on this computer" }]);
    expect(s.verdict).toMatchObject({ level: "near-duplicate", agreement: "single" });
  });

  it("records an unchecked result (never throws) when neither AI answers", async () => {
    const ask: SimilarityAsk = async () => {
      throw new Error("AI budget exhausted: today's AI token allowance is used up");
    };
    await runSimilarityCheck({ targets: ["speedjob:1"] }, { store, ask, entries: queueNow(), now: () => NOW });
    const s = storedSimilarity("speedjob:1", store)!;
    expect(s.verdict.level).toBe("unchecked");
    expect(s.unavailable.map((u) => u.reason)).toEqual(["today's AI token allowance is used up", "today's AI token allowance is used up"]);
    expect(looksSimilar(s)).toBe(true);
  });

  it("caches by the compared set: no new AI call until the set changes or Check again is pressed", async () => {
    const first = fakeAsk();
    await runSimilarityCheck({ targets: ["speedjob:1"] }, { store, ask: first.ask, entries: queueNow(), now: () => NOW });
    expect(first.calls).toHaveLength(2);

    const again = fakeAsk();
    await runSimilarityCheck({ targets: ["speedjob:1"] }, { store, ask: again.ask, entries: queueNow(), now: () => NOW });
    expect(again.calls).toHaveLength(0);

    // approving a clip changes its status, not the compared set
    const approved = queueNow().map((e) => (e.key === "speedjob:2:youtube" ? { ...e, status: "scheduled" as const, slotAt: NOW + DAY } : e));
    await runSimilarityCheck({ targets: ["speedjob:1"] }, { store, ask: again.ask, entries: approved, now: () => NOW });
    expect(again.calls).toHaveLength(0);

    // rejecting one does change it
    const rejected = queueNow().map((e) => (e.key === "speedjob:3:youtube" ? { ...e, status: "rejected" as const } : e));
    await runSimilarityCheck({ targets: ["speedjob:1"] }, { store, ask: again.ask, entries: rejected, now: () => NOW });
    expect(again.calls).toHaveLength(2);

    const forced = fakeAsk();
    await runSimilarityCheck({ targets: ["speedjob:1"], force: true }, { store, ask: forced.ask, entries: rejected, now: () => NOW });
    expect(forced.calls).toHaveLength(2);
  });

  it("the sweep settles lone clips itself and queues AI work only for changed groups", async () => {
    const queued: { workKey: string; inputRevision: number; payload: Record<string, unknown> }[] = [];
    const enqueue = async (w: (typeof queued)[number]) => void queued.push(w);
    expect(await similaritySweep({ store, entries: queueNow(), now: () => NOW, enqueue })).toBe(1);
    expect(queued[0]!.payload).toEqual({ targets: ["speedjob:1", "speedjob:2", "speedjob:3"] });
    expect(Number.isSafeInteger(queued[0]!.inputRevision)).toBe(true);
    expect(storedSimilarity("plants:1", store)!.verdict.level).toBe("distinct");
    // while queued it shows "checking" with the pre-pass matches, and isn't queued twice
    expect(storedSimilarity("speedjob:1", store)).toMatchObject({ checkedAt: 0, checking: NOW });
    expect(storedSimilarity("speedjob:1", store)!.candidates.length).toBeGreaterThan(0);
    expect(await similaritySweep({ store, entries: queueNow(), now: () => NOW + 30_000, enqueue })).toBe(0);
    // once checked, nothing more to do
    await runSimilarityCheck({ targets: queued[0]!.payload.targets as string[] }, { store, ask: fakeAsk().ask, entries: queueNow(), now: () => NOW });
    expect(storedSimilarity("speedjob:1", store)!.checking).toBeUndefined();
    expect(await similaritySweep({ store, entries: queueNow(), now: () => NOW + 60_000, enqueue })).toBe(0);
    // a new look-alike lands in review: queued again
    const more = [...queueNow(), entry("speedjob", 5, { clipTitle: "$500 2K wager, the ending" })];
    expect(await similaritySweep({ store, entries: more, now: () => NOW + 90_000, enqueue })).toBe(1);
    expect(queued[1]!.payload.targets).toContain("speedjob:5");
  });

  it("Check again queues a forced check and marks the clip as checking", async () => {
    const queued: { workKey: string; payload: Record<string, unknown> }[] = [];
    const s = await requestSimilarityCheck(entry("speedjob", 1), {
      store,
      now: NOW,
      enqueue: async (w) => void queued.push(w),
    });
    expect(queued).toEqual([expect.objectContaining({ kind: "similarity", payload: { targets: ["speedjob:1"], force: true } })]);
    expect(s?.checking).toBe(NOW);
  });

  it("publicQueueEntry carries the clip's record", async () => {
    await runSimilarityCheck({ targets: ["speedjob:1"] }, { store, ask: fakeAsk().ask, entries: queueNow(), now: () => NOW });
    const pub = publicQueueEntry(entry("speedjob", 1, { platform: "tiktok", key: "speedjob:1:tiktok" }));
    expect(pub.similarity?.verdict.level).toBe("near-duplicate");
    expect(pub.similarity?.setHash).toBe(similaritySetHash(clipFacts(queueNow(), NOW, store).filter((f) => f.id.startsWith("speedjob:"))));
  });
});
