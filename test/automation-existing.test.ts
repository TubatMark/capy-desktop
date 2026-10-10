import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const env = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const p = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "capy-c3-existing-"));
  process.env.CAPY_OUTPUT = p.join(root, "out");
  return { root };
});
vi.mock("../server/boot", () => ({ boot() {} }));
import { jobs } from "../server/jobs";
import { watcherTick } from "../server/watcher";
import { runtimeStore } from "../server/db/runtime";
import { workQueue } from "../server/worker/api";
import { WorkQueue } from "../server/worker/leases";
import { saveCreatorPolicy, recipeSettings } from "../server/automation-policy";
import { DEFAULT_CREATOR_POLICY } from "../lib/creator-policy";
import { DEFAULT_SETTINGS, type JobState, type QueueEntry } from "../lib/types";
import { addChannel, watch } from "../server/watch";
import { resetSettingsCache } from "../server/settings";
import { queue, resetQueueCache } from "../server/queue";
import { decide, eligibility } from "../server/publication-policy";
import { publicationFixture } from "./publication-fixtures";
const id = "video123456",
  channelId = "creator";
let seq = 0;
beforeEach(() => {
  process.env.CAPY_DATA_DIR = path.join(env.root, `data-${++seq}`);
  globalThis.__capyJobs = undefined;
  resetSettingsCache();
  resetQueueCache();
});
afterAll(() => {
  rmSync(env.root, { recursive: true, force: true });
  delete process.env.CAPY_DATA_DIR;
  delete process.env.CAPY_OUTPUT;
});
function setup(count = 8) {
  const now = Date.now();
  const p = saveCreatorPolicy(channelId, {
    ...DEFAULT_CREATOR_POLICY,
    mode: "automatic_drafts",
    clips: 3,
    editTemplate: "clean-portrait-v1",
    destinationAccountIds: ["fixture-account"],
    requireModelReview: false,
  });
  watch().mutate((f) =>
    addChannel(
      f,
      {
        id: channelId,
        name: "Creator",
        url: "https://youtube.com/channel/creator/videos",
      },
      [],
      { now: new Date(now) },
    ),
  );
  watch().mutate((f) => ({
    ...f,
    channels: f.channels.map((c) => ({
      ...c,
      pending: [{ id, title: "Existing source", duration: 600, foundAt: now }],
    })),
  }));
  const manual: JobState = {
    id,
    videoId: id,
    url: `https://youtube.com/watch?v=${id}`,
    status: "ready",
    stage: "done",
    createdAt: now,
    stageStartedAt: now,
    dir: id,
    settings: { ...DEFAULT_SETTINGS, style: "bold", lang: "pt", count: 8 },
    estimate: { stageRemaining: 0, totalRemaining: 0, progress: 1 },
    log: [],
    clips: Array.from({ length: count }, (_, n) => ({
      n: n + 1,
      start: n * 30,
      end: n * 30 + 25,
      title: `Clip${n}`,
      hook: "",
      reason: "manual",
      score: 9,
      selected: true,
      segment: {
        start: n * 30,
        end: n * 30 + 25,
        status: "done",
        url: "/fixture.mp4",
      },
      render: { status: "none" },
    })),
  };
  return { manual, p, now };
}
function persist(job: JobState) {
  runtimeStore().put("legacy-jobs", job.id, job);
}
function decisions() {
  return runtimeStore()
    .list<{ reason: string; kind: string }>("automation-decisions")
    .map((r) => r.value);
}
async function intake(
  now: number,
  createJob = async (
    videoId: string,
    settings: Partial<JobState["settings"]>,
    automation: NonNullable<JobState["automation"]>,
    admission?: unknown,
  ) => {
    await jobs().create(`https://youtube.com/watch?v=${videoId}`, settings, {
      automation,
      ...({ automationAdmission: admission } as {}),
    });
  },
) {
  await watcherTick({
    now: () => new Date(now + 1000),
    lock: () => "held",
    list: async () => [],
    createJob,
    createAdmittedJob: createJob,
  });
}
it("a genuinely new source commits its job and recipe admission before queuing costly media work", async () => {
  const { p, now } = setup();
  publicationFixture();
  const q = workQueue(),
    original = WorkQueue.prototype.enqueue;
  const evidence: boolean[] = [];
  const enqueue = vi
    .spyOn(WorkQueue.prototype, "enqueue")
    .mockImplementation(async function (this: WorkQueue, input) {
      evidence.push(
        !!runtimeStore().get("legacy-jobs", id) &&
          !!runtimeStore().get("automation-jobs", id) &&
          !!runtimeStore().get("automation-admissions", id),
      );
      return original.call(this, input);
    });
  try {
    await intake(now);
    expect(evidence).toEqual([true]);
    expect(jobs().get(id)?.settings).toMatchObject({
      count: 3,
      style: "clean",
    });
    expect(jobs().get(id)?.automation?.recipeId).toBe(p.recipeId);
    expect(
      runtimeStore().get<{ clips: number }>("automation-admissions", id)?.value
        .clips,
    ).toBe(3);
    expect(q.list()).toHaveLength(1);
    expect(q.list()[0]!.payload).toMatchObject({
      jobId: id,
      automated: true,
      operation: "analyze",
    });
  } finally {
    enqueue.mockRestore();
  }
});
it("eight selected manual clips cannot be adopted by a three-clip recipe or change manual settings", async () => {
  const { manual, now } = setup();
  publicationFixture();
  persist(manual);
  const before = runtimeStore().get("legacy-jobs", id);
  await intake(now);
  expect(runtimeStore().get("legacy-jobs", id)).toEqual(before);
  expect(jobs().get(id)).toEqual(manual);
  expect(
    workQueue()
      .list()
      .filter((j) => j.kind === "media"),
  ).toEqual([]);
  expect(runtimeStore().get("automation-jobs", id)).toBeUndefined();
  expect(runtimeStore().get("automation-admissions", id)).toBeUndefined();
  expect(decisions()).toContainEqual(
    expect.objectContaining({
      kind: "defer",
      reason: expect.stringMatching(/manual.*preserv|preserv.*manual/i),
    }),
  );
  expect(
    watch()
      .get()
      .channels[0]!.pending.map((v) => v.id),
  ).toEqual([id]);
});
it("finished approved scheduled manual output keeps its publication package, queue and eligibility", async () => {
  const { manual, now } = setup(1);
  const files = publicationFixture();
  manual.clips[0]!.render = {
    status: "done",
    file: files.file,
    url: "/fixture.mp4",
  };
  persist(manual);
  const e: QueueEntry = {
    key: `${id}:1:youtube`,
    jobId: id,
    n: 1,
    platform: "youtube",
    status: "review",
    clipTitle: "Manual",
    text: { title: "Manual" },
    attempts: 0,
    history: [],
    createdAt: now,
    updatedAt: now,
    publicationFiles: files,
  };
  const approved = {
    ...decide(e, false, new Date(now)),
    status: "scheduled" as const,
    slotAt: now + 86400000,
  };
  queue().mutate(() => [approved]);
  expect(eligibility(approved).allowed).toBe(true);
  const jobBefore = runtimeStore().get("legacy-jobs", id),
    queueBefore = queue().list();
  await intake(now);
  expect(runtimeStore().get("legacy-jobs", id)).toEqual(jobBefore);
  expect(queue().list()).toEqual(queueBefore);
  expect(eligibility(queue().list()[0]!).allowed).toBe(true);
  expect(runtimeStore().get("automation-jobs", id)).toBeUndefined();
  expect(runtimeStore().get("automation-admissions", id)).toBeUndefined();
});
it("matching automated retry preserves immutable admission and renders only its three selected clips", async () => {
  const { manual, p, now } = setup(3);
  publicationFixture();
  manual.automation = {
    channelId,
    channelName: "Creator",
    recipeId: p.recipeId,
  };
  const recipe = runtimeStore().get<
    import("../lib/creator-policy").CreatorRecipe
  >("creator-recipes", p.recipeId!)!.value;
  manual.settings = { ...manual.settings, ...recipeSettings(recipe) };
  delete manual.settings.lang;
  persist(manual);
  runtimeStore().put("automation-jobs", id, {
    channelId,
    recipeId: p.recipeId,
    sourceMethod: "videos-tab",
  });
  runtimeStore().put("automation-admissions", id, {
    channelId,
    clips: 3,
    at: now - 1000,
    destination: "fixture-account",
  });
  const linkBefore = runtimeStore().get("automation-jobs", id),
    admissionBefore = runtimeStore().get("automation-admissions", id);
  await jobs().init();
  const render = vi.spyOn(jobs(), "render").mockResolvedValue(manual);
  await intake(now);
  expect(render).toHaveBeenCalledWith(id, [1, 2, 3]);
  expect(runtimeStore().get("automation-jobs", id)).toEqual(linkBefore);
  expect(runtimeStore().get("automation-admissions", id)).toEqual(
    admissionBefore,
  );
  expect(jobs().get(id)?.settings).toEqual(manual.settings);
  render.mockRestore();
});
it("an automated analysis retry with no picks preserves its saved settings rather than adopting current channel options", async () => {
  const { manual, p, now } = setup(0);
  const recipe = runtimeStore().get<
    import("../lib/creator-policy").CreatorRecipe
  >("creator-recipes", p.recipeId!)!.value;
  manual.settings = {
    ...manual.settings,
    ...recipeSettings(recipe),
    audience: "original",
  };
  delete manual.settings.lang;
  manual.automation = {
    channelId,
    channelName: "Creator",
    recipeId: p.recipeId,
  };
  persist(manual);
  runtimeStore().put("automation-jobs", id, {
    channelId,
    recipeId: p.recipeId,
  });
  runtimeStore().put("automation-admissions", id, {
    channelId,
    clips: 3,
    at: now,
    destination: "fixture-account",
  });
  await jobs().create(
    manual.url,
    { audience: "en-us" },
    { automation: manual.automation },
  );
  expect(jobs().get(id)?.settings).toEqual(manual.settings);
  expect(workQueue().list()[0]!.payload).toMatchObject({
    automated: true,
    operation: "analyze",
  });
});
it.each(["selection", "template"] as const)(
  "an automated retry with edited %s defers without mutating manual edits or its admission",
  async (edit) => {
    const { manual, p, now } = setup(edit === "selection" ? 8 : 3);
    publicationFixture();
    manual.automation = {
      channelId,
      channelName: "Creator",
      recipeId: p.recipeId,
    };
    const recipe = runtimeStore().get<
      import("../lib/creator-policy").CreatorRecipe
    >("creator-recipes", p.recipeId!)!.value;
    manual.settings = { ...manual.settings, ...recipeSettings(recipe) };
    delete manual.settings.lang;
    if (edit === "template") manual.settings.style = "bold";
    persist(manual);
    runtimeStore().put("automation-jobs", id, {
      channelId,
      recipeId: p.recipeId,
    });
    runtimeStore().put("automation-admissions", id, {
      channelId,
      clips: 3,
      at: now - 1000,
      destination: "fixture-account",
    });
    const before = runtimeStore().get("legacy-jobs", id),
      receipt = runtimeStore().get("automation-admissions", id);
    await intake(now);
    expect(runtimeStore().get("legacy-jobs", id)).toEqual(before);
    expect(runtimeStore().get("automation-admissions", id)).toEqual(receipt);
    expect(
      workQueue()
        .list()
        .filter((j) => j.kind === "media"),
    ).toEqual([]);
    expect(decisions()).toContainEqual(
      expect.objectContaining({
        kind: "defer",
        reason: expect.stringMatching(/selections|settings/),
      }),
    );
    await jobs().init();
    const render = vi.spyOn(jobs(), "render");
    await jobs().onReady(jobs().get(id)!);
    expect(render).not.toHaveBeenCalled();
    render.mockRestore();
  },
);
it("a manual job created after watcher preflight is rejected by Jobs.create without attaching metadata or queuing work", async () => {
  const { manual, now } = setup();
  publicationFixture();
  await intake(now, async (videoId, settings, automation, admission) => {
    persist(manual);
    await jobs().create(`https://youtube.com/watch?v=${videoId}`, settings, {
      automation,
      ...({ automationAdmission: admission } as {}),
    });
  });
  expect(runtimeStore().get("legacy-jobs", id)?.value).toEqual(manual);
  expect(runtimeStore().get("automation-jobs", id)).toBeUndefined();
  expect(runtimeStore().get("automation-admissions", id)).toBeUndefined();
  expect(
    workQueue()
      .list()
      .filter((j) => j.kind === "media"),
  ).toEqual([]);
  expect(decisions()).toContainEqual(
    expect.objectContaining({
      kind: "defer",
      reason: expect.stringMatching(/manual/i),
    }),
  );
  expect(
    watch()
      .get()
      .channels[0]!.pending.map((v) => v.id),
  ).toEqual([id]);
  expect(watch().get().channels[0]!.history).toEqual([]);
});
