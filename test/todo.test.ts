import { describe, expect, it } from "vitest";
import { filterLibrary, type LibraryVideo } from "../lib/library";
import { longVideoNeedsOwner, type LongVideo } from "../lib/longform";
import { queueLink } from "../lib/queue-source";
import type { JobRecord } from "../lib/studio/types";
import type { QueueEntry } from "../lib/types";
import { accountTasks, postTasks, todoTasks, videoTasks, WORK_TASK_MAX_AGE_MS, workTasks } from "../server/tasks";

const NOW = 2_000_000_000_000;
const post = (n: number, status: QueueEntry["status"], extra: Partial<QueueEntry> = {}): QueueEntry => ({ key: `j:${n}:youtube`, jobId: "j", n, platform: "youtube", status, clipTitle: `Clip ${n}`, text: {}, attempts: 0, history: [], createdAt: 0, updatedAt: 1, ...extra });
const job = (extra: Partial<JobRecord>): JobRecord => ({ id: "w", kind: "media", workKey: "k", inputRevision: 1, payload: {}, stage: "meta", status: "needs_action", checkpoint: {}, generation: 1, expiresAt: 0, attempts: 3, cancelRequested: false, createdAt: NOW - 1000, groups: [], ...extra });
const video = (extra: Partial<LongVideo>): LongVideo => ({ id: "a", creator: "Kai", title: "Best of Kai", status: "review", clips: [], createdAt: 1, ...extra }) as LongVideo;
const empty = { work: [], queue: [], videos: [], accounts: [], autoSchedule: true, now: NOW };

describe("To do", () => {
  it("is empty when nothing is stuck, even with clips waiting for a slot", () => {
    expect(todoTasks(empty)).toEqual([]);
    expect(todoTasks({ ...empty, queue: [post(1, "review"), post(2, "scheduled"), post(3, "posted"), post(4, "rejected")] })).toEqual([]);
  });

  it("asks for approval only when the owner turned automatic scheduling off", () => {
    const t = todoTasks({ ...empty, autoSchedule: false, queue: [post(1, "review"), post(2, "review"), post(3, "scheduled")] });
    expect(t).toMatchObject([{ kind: "queue", href: "/short-form" }]);
    expect(t[0]!.title).toMatch(/2 waiting clips/);
  });

  it("lists failed and needs-action posts once per clip, linking to Short form", () => {
    const t = postTasks([post(1, "failed", { error: "Upload refused" }), post(1, "needs_action", { key: "j:1:tiktok", platform: "tiktok" }), post(2, "needs_action", { result: { note: "Finish it in the app" } } as Partial<QueueEntry>), post(3, "scheduled")]);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ tone: "block", href: "/short-form", detail: "Upload refused" });
    expect(t[1]).toMatchObject({ tone: "action", detail: "Finish it in the app" });
  });

  it("treats too little footage as normal, and work capy is still retrying as not yet a problem", () => {
    expect(longVideoNeedsOwner(video({ error: "Kai has about 4 minutes of usable footage. A long video needs at least 8.", failedStep: "plan" }))).toBeNull();
    expect(longVideoNeedsOwner(video({ error: "Kai has about 4 minutes of usable footage.", manual: true }))).toBeNull();
    expect(longVideoNeedsOwner(video({ error: "Render broke", failedStep: "render", autoRetries: 1 }))).toBeNull();
    expect(workTasks([job({ kind: "media", error: "Kai has about 3 minutes of usable footage." })], NOW)).toEqual([]);
  });

  it("lists long videos with an error it gave up on, or file notes it won't publish past", () => {
    expect(longVideoNeedsOwner(video({ error: "Render broke", failedStep: "render", autoRetries: 2 }))).toBe("error");
    expect(longVideoNeedsOwner(video({ error: "Render broke", manual: true }))).toBe("error");
    const warned = video({ check: { ok: false, warnings: ["Audio too quiet"] } } as Partial<LongVideo>);
    expect(videoTasks([warned])).toMatchObject([{ href: "/longform", detail: "Audio too quiet", tone: "warn" }]);
    expect(videoTasks([{ ...warned, status: "public" }, { ...warned, slotAt: 5 }, { ...warned, manual: true }, video({})])).toEqual([]);
  });

  it("links an account that needs signing in to Settings", () => {
    expect(accountTasks([{ platform: "youtube", needsReconnect: true }, { platform: "tiktok" }], NOW)).toMatchObject([{ href: "/settings#accounts", title: "Sign in to YouTube again", tone: "block" }]);
  });

  it("passes only stopped background work, one task per problem, and drops what's too old to matter", () => {
    expect(workTasks([job({ status: "complete" }), job({ status: "running" }), job({ status: "retryable" })], NOW)).toEqual([]);
    expect(workTasks([job({ kind: "longform", error: "Render broke" })], NOW)).toEqual([]);
    expect(workTasks([job({ createdAt: NOW - WORK_TASK_MAX_AGE_MS - 1, error: "Old" })], NOW)).toEqual([]);
    const t = workTasks([job({ id: "1", error: "Disk full", payload: { jobId: "abc" } }), job({ id: "2", error: "Disk full" }), job({ id: "3", kind: "poster", status: "blocked", error: "Budget" })], NOW);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ href: "/v/abc", detail: "Disk full (2 times)" });
    expect(t[1]).toMatchObject({ href: "/short-form", tone: "warn" });
  });

  it("puts the most urgent first", () => {
    const t = todoTasks({ ...empty, work: [job({ status: "blocked", error: "Budget" })], queue: [post(1, "needs_action")], accounts: [{ platform: "youtube", needsReconnect: true }] });
    expect(t.map((x) => x.tone)).toEqual(["block", "action", "warn"]);
  });
});

describe("queue links", () => {
  it("sends removed Stories and Studio pages to Short form, old saved links included", () => {
    expect(queueLink(post(1, "review", { link: "/stories/ser/st" }))).toBe("/short-form");
    expect(queueLink(post(1, "review", { link: "/studio/p" }))).toBe("/short-form");
    expect(queueLink(post(1, "review", { source: { kind: "studio", projectId: "p", revision: 1, renderId: "r", renderChecksum: "a".repeat(64) } }))).toBe("/short-form");
    expect(queueLink(post(1, "review", { link: "/v/x" }))).toBe("/v/x");
    expect(queueLink(post(7, "review"))).toBe("/v/j/clip/7");
  });
});

describe("Library search", () => {
  const v = (title: string, channel?: string) => ({ id: title, videoId: title, title, channel, status: "ready", clips: 0, rendered: 0 }) as LibraryVideo;
  it("matches title or channel, ignoring case", () => {
    const all = [v("NBA 2K marathon", "IShowSpeed"), v("Plant care"), v("Speedrun", "Kai")];
    expect(filterLibrary(all, "  ").length).toBe(3);
    expect(filterLibrary(all, "speed").map((x) => x.id)).toEqual(["NBA 2K marathon", "Speedrun"]);
    expect(filterLibrary(all, "PLANT").map((x) => x.id)).toEqual(["Plant care"]);
  });
});
