import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CREATOR_POLICY,
  DEFAULT_CONTROLS,
} from "../lib/creator-policy";
import {
  planCreatorWork,
  rankCreatorWork,
  admissionReasons,
  saveCreatorPolicy,
  creatorRecipe,
  creatorPolicy,
} from "../server/automation-policy";
import { resetSettingsCache, saveSettings } from "../server/settings";
import { runtimeStore } from "../server/db/runtime";
import { WorkQueue } from "../server/worker/leases";
import { runJob } from "../server/worker/runner";
const policy = {
  ...DEFAULT_CREATOR_POLICY,
  mode: "automatic_drafts" as const,
  destinationAccountIds: ["dest"],
  clips: 3,
};
const input = (id: string, priority = 0) => ({
  candidate: {
    id,
    channelId: "creator",
    foundAt: 1000,
    durationSec: 600,
    title: id,
    priority,
  },
  policy,
  now: 2000,
  capacity: {
    unpublished: 0,
    reservedClips: 0,
    destinationDailySlots: 2,
    targetDays: 3,
    maxBacklogDays: 7,
    remainingRenderClips: 6,
  },
  sourceAllowed: true,
  destinationAccountId: "dest",
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  delete process.env.CAPY_DATA_DIR;
  resetSettingsCache();
});
describe("creator automation", () => {
  it("capacity_limits_cost_before_render ranks six sources / 18 clips into six slots", () => {
    const decisions = rankCreatorWork(
      Array.from({ length: 6 }, (_, i) => input(String(i), i)),
    );
    expect(
      decisions.filter((d) => d.kind === "proceed").map((d) => d.candidateId),
    ).toEqual(["5", "4"]);
    expect(
      decisions
        .filter((d) => d.kind === "proceed")
        .reduce((n, d) => n + d.budget.clips, 0),
    ).toBe(6);
    expect(decisions.filter((d) => d.kind === "defer")).toHaveLength(4);
    expect(decisions.every((d) => d.reason.length > 5)).toBe(true);
  });
  it("manual imports bypass intake caps while explicit expiry does not silently discard candidates", () => {
    expect(
      planCreatorWork({
        ...input("manual"),
        manual: true,
        capacity: { ...input("manual").capacity, remainingRenderClips: 0 },
      }).kind,
    ).toBe("proceed");
    expect(
      planCreatorWork({
        ...input("old"),
        now: 1000 + 80 * 3600000,
        policy: { ...policy, expireFreshness: false },
      }).kind,
    ).toBe("defer");
    expect(
      planCreatorWork({
        ...input("old"),
        now: 1000 + 80 * 3600000,
        policy: { ...policy, expireFreshness: true },
      }),
    ).toMatchObject({
      kind: "skip",
      reason: expect.stringMatching(/expired/i),
    });
    expect(
      planCreatorWork({
        ...input("duration"),
        candidate: { ...input("duration").candidate, durationSec: 40 },
      }).kind,
    ).toBe("skip");
    expect(
      planCreatorWork({
        ...input("dest"),
        candidate: { ...input("dest").candidate, channelId: "dest" },
      }).kind,
    ).toBe("skip");
  });
  it("immutable recipes survive settings updates and automatic publication cannot be enabled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "capy-c3-policy-"));
    roots.push(root);
    process.env.CAPY_DATA_DIR = root;
    resetSettingsCache();
    const one = saveCreatorPolicy("creator", policy);
    const two = saveCreatorPolicy("creator", {
      ...policy,
      editTemplate: "clean-portrait-v1",
    });
    expect(one.recipeId).not.toBe(two.recipeId);
    expect(creatorRecipe(one.recipeId!)).toMatchObject({
      editTemplate: "bold-portrait-v1",
    });
    expect(() =>
      saveCreatorPolicy("creator", { ...policy, mode: "automatic_publish" }),
    ).toThrow(/72.hour|soak/i);
  });
  it("monitor/render/post pauses and stop prevent actual future stage execution independently", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "capy-c3-admit-"));
    roots.push(root);
    process.env.CAPY_DATA_DIR = root;
    resetSettingsCache();
    for (const [kind, control] of [
      ["watcher", "monitorPaused"],
      ["media", "renderPaused"],
      ["poster", "postPaused"],
      ["asset-proxy", "globalStop"],
    ] as const) {
      saveSettings({
        automationControls: { ...DEFAULT_CONTROLS, [control]: true },
      });
      const q = new WorkQueue(runtimeStore());
      const j = await q.enqueue({
        kind,
        workKey: kind,
        inputRevision: 0,
        payload: {},
      });
      const l = (await q.claim("owner"))!;
      let calls = 0;
      await runJob(l, new AbortController().signal, {
        queue: q,
        artifactRoot: root,
        stages: [
          {
            name: "future",
            run: async () => {
              calls++;
            },
          },
        ],
        admit: async (job) => admissionReasons(job),
      });
      expect(calls).toBe(0);
      expect(q.get(j.id)?.status).toBe("blocked");
      expect(q.get(j.id)?.error).toMatch(/paused|stop/i);
    }
    saveSettings({
      automationControls: { ...DEFAULT_CONTROLS, monitorPaused: true },
    });
    expect(admissionReasons({ kind: "media" })).toEqual([]);
  });
});

import { addChannel, watch } from "../server/watch";
import { saveAccount } from "../server/accounts";
import { watcherTick } from "../server/watcher";
import { getAutomationPublicationChecks } from "../server/automation-policy";
import { automationHealth } from "../server/worker/health";
import {
  buildPublishPackage,
  hashManifest,
  mediaOptions,
  publicationContext,
  PUBLICATION_POLICY_VERSION,
} from "../server/publication-policy";
import { evaluatePublication } from "../lib/publication";
import type { QueueEntry } from "../lib/types";
it("watcher keeps reasons for six ranked sources and admits only two within six clips before any media calls", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "capy-c3-watch-"));
  roots.push(root);
  process.env.CAPY_DATA_DIR = root;
  resetSettingsCache();
  saveAccount("youtube", {
    account: { id: "dest", name: "Fixture" },
    tokens: { accessToken: "fixture", expiresAt: Date.now() + 3600000 },
    autoPost: true,
  });
  for (let i = 0; i < 6; i++) {
    const id = `creator${i}`;
    watch().mutate((f) =>
      addChannel(
        f,
        { id, name: id, url: `https://youtube.com/channel/${id}/videos` },
        [],
        { now: new Date(1000) },
      ),
    );
    saveCreatorPolicy(id, { ...policy });
  }
  watch().mutate((f) => ({
    ...f,
    maxPerDay: 100,
    channels: f.channels.map((c) => ({
      ...c,
      settings: { ...c.settings, perDay: 100 },
      pending: [
        { id: `video-${c.id}`, title: "Fixture", foundAt: 1000, duration: 600 },
      ],
    })),
  }));
  const created: string[] = [];
  for (let n = 0; n < 6; n++) {
    await watcherTick({
      now: () => new Date(2000),
      lock: () => "held",
      list: async () => [],
      createJob: async (id) => {
        created.push(id);
      },
    });
    watch().mutate((f) => ({
      ...f,
      channels: f.channels.map((c) => ({
        ...c,
        history: c.history.map((h) => ({ ...h, status: "rendered" })),
      })),
    }));
  }
  expect(created).toHaveLength(2);
  expect(
    watch()
      .get()
      .channels.flatMap((c) => c.pending),
  ).toHaveLength(4);
  expect(runtimeStore().list("automation-admissions")).toHaveLength(2);
  expect(
    runtimeStore()
      .list<{ reason: string; kind: string }>("automation-decisions")
      .filter((r) => r.value.kind === "defer")
      .every((r) => r.value.reason.includes("capacity")),
  ).toBe(true);
  expect(runtimeStore().list("ai-reservation")).toEqual([]);
});
it("auto_mode_requires_passing_current_package: source, quality, review, recipe and thumbnail failures remain central gate reasons", () => {
  const root = mkdtempSync(path.join(tmpdir(), "capy-c3-package-"));
  roots.push(root);
  process.env.CAPY_DATA_DIR = root;
  resetSettingsCache();
  const p = saveCreatorPolicy("creator", {
    ...policy,
    requireModelReview: true,
    thumbnailRequired: true,
  });
  const store = runtimeStore();
  store.put("automation-jobs", "fixture-job", {
    channelId: "creator",
    recipeId: p.recipeId,
  });
  const review = {
    verdict: "ok" as const,
    summary: "Fixture",
    issues: [],
    at: 2000,
  };
  const e: QueueEntry = {
    key: "fixture-job:1:youtube",
    jobId: "fixture-job",
    n: 1,
    platform: "youtube",
    status: "review",
    clipTitle: "Fixture",
    text: { title: "Fixture" },
    attempts: 0,
    history: [],
    createdAt: 1000,
    updatedAt: 2000,
    aiReview: review,
  };
  e.publishPackage = buildPublishPackage({
    id: "pkg",
    artifact: { id: "clip", checksum: "a".repeat(64) },
    text: e.text,
    textHash: hashManifest(e.text),
    platform: "youtube",
    accountId: "dest",
    review,
    policyVersion: PUBLICATION_POLICY_VERSION,
    mediaOptionsHash: mediaOptions(e),
    deliveryOptions: { mode: "public", privacyPolicy: "public" },
  });
  expect(getAutomationPublicationChecks(e)).toMatchObject({
    required: true,
    reasons: expect.arrayContaining([
      expect.stringMatching(/quality report/),
      expect.stringMatching(/thumbnail/),
    ]),
  });
  store.put("media-quality", "a".repeat(64), {
    artifactId: "clip",
    checksum: "a".repeat(64),
    revision: 0,
    reviewVersion: "deterministic-media-v1",
    policy: {
      aspect: "portrait",
      requireAudio: false,
      maxBlackRatio: 0.9,
      maxFrozenRatio: 1,
    },
    passed: true,
    checks: [
      "identity",
      "duration",
      "aspect",
      "decode",
      "black",
      "audio",
      "frozen",
      "captions",
    ].map((id) => ({ id, pass: true, reason: "Fixture measured check" })),
    at: 2000,
    modelReview: { status: "not_requested", reason: "technical only" },
  });
  expect(getAutomationPublicationChecks(e).reasons).not.toContain(
    "Current media quality report is missing or stale",
  );
  const withoutReview = {
    ...e,
    publishPackage: { ...e.publishPackage, review: undefined },
  };
  const reviewReason =
    "The AI review flagged this clip or couldn't run; read it, then approve";
  expect(getAutomationPublicationChecks(withoutReview).reasons).toContain(
    reviewReason,
  );
  // approving this exact package is the human check; approving an older one is not
  expect(
    getAutomationPublicationChecks({
      ...withoutReview,
      publicationDecision: {
        kind: "human",
        packageHash: withoutReview.publishPackage.packageHash,
        at: 3000,
      },
    }).reasons,
  ).not.toContain(reviewReason);
  expect(
    getAutomationPublicationChecks({
      ...withoutReview,
      publicationDecision: { kind: "human", packageHash: "b".repeat(64), at: 3000 },
    }).reasons,
  ).toContain(reviewReason);
  saveCreatorPolicy("creator", { ...p, requireAudio: true });
  expect(getAutomationPublicationChecks(e).reasons).toContain(
    "Current media quality report is missing or stale",
  );
  const context = {
    ...publicationContext(e),
    artifactHash: e.publishPackage.artifact.checksum,
    connectedAccountId: "dest",
    approval: {
      kind: "human" as const,
      packageHash: e.publishPackage.packageHash,
      at: 2000,
    },
  };
  expect(evaluatePublication(e.publishPackage, context).reasons).toContain(
    "Creator requires an approved current thumbnail",
  );
  expect(
    evaluatePublication(e.publishPackage, { ...context, approval: undefined })
      .allowed,
  ).toBe(false);
  expect(getAutomationPublicationChecks({ ...e, jobId: undefined })).toEqual({
    required: false,
    reasons: [],
  });
});
it("health shows expired worker offline and preserves current stage/backlog/durable exception evidence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "capy-c3-health-"));
  roots.push(root);
  process.env.CAPY_DATA_DIR = root;
  resetSettingsCache();
  runtimeStore().put("worker", "service", {
    heartbeat: Date.now() - 60000,
    expiresAt: Date.now() - 30000,
  });
  runtimeStore().put("automation-decisions", "source", {
    candidateId: "source",
    kind: "defer",
    reason: "Destination calendar is at capacity",
    at: 2000,
  });
  const h = await automationHealth();
  expect(h.online).toBe(false);
  expect(h.activeStage).toBeUndefined();
  expect(h.publication.enabled).toBe(false);
  expect(h.reasons).toContainEqual({
    id: "source",
    reason: "Destination calendar is at capacity",
    at: 2000,
  });
});
it("legacy enabled manual metadata produces bounded account-free drafts, explicit saved manual and disabled creators stay waiting", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "capy-c3-legacy-"));
  roots.push(root);
  process.env.CAPY_DATA_DIR = root;
  resetSettingsCache();
  watch().mutate((f) =>
    addChannel(
      f,
      {
        id: "legacy",
        name: "Legacy",
        url: "https://youtube.com/channel/legacy/videos",
      },
      [],
      { now: new Date(1000) },
    ),
  );
  watch().mutate((f) => ({
    ...f,
    channels: f.channels.map((c) => ({
      ...c,
      mode: "manual",
      pending: [{ id: "new", title: "New", duration: 600, foundAt: 1000 }],
    })),
  }));
  const created: string[] = [];
  const deps = {
    now: () => new Date(2000),
    lock: () => "held" as const,
    list: async () => [],
    createJob: async (id: string) => {
      created.push(id);
    },
  };
  await watcherTick(deps);
  expect(created).toEqual(["new"]);
  watch().mutate((f) => ({
    ...f,
    channels: f.channels.map((c) => ({
      ...c,
      history: [],
      pending: [{ id: "next", title: "Next", duration: 600, foundAt: 1000 }],
    })),
  }));
  saveCreatorPolicy("legacy", { ...DEFAULT_CREATOR_POLICY, mode: "manual" });
  await watcherTick(deps);
  expect(created).toEqual(["new"]);
  expect(watch().get().channels[0]!.pending).toHaveLength(1);
  expect(
    planCreatorWork({
      ...input("offline-destination"),
      policy: { ...DEFAULT_CREATOR_POLICY, mode: "automatic_drafts" },
      destinationAccountId: undefined,
    }).kind,
  ).toBe("proceed");
});
it("already admitted automated render rechecks capacity while a manual work request remains available", () => {
  const root = mkdtempSync(path.join(tmpdir(), "capy-c3-recheck-"));
  roots.push(root);
  process.env.CAPY_DATA_DIR = root;
  resetSettingsCache();
  watch().mutate((f) =>
    addChannel(
      f,
      {
        id: "creator",
        name: "Creator",
        url: "https://youtube.com/channel/creator/videos",
      },
      [],
      { now: new Date(1000) },
    ),
  );
  const saved = saveCreatorPolicy("creator", policy);
  runtimeStore().put("automation-jobs", "source", {
    channelId: "creator",
    recipeId: saved.recipeId,
  });
  runtimeStore().put(
    "legacy-state",
    "queue",
    Array.from({ length: 6 }, (_, i) => ({
      jobId: "another",
      n: i,
      status: "review",
    })),
  );
  expect(
    admissionReasons({
      kind: "media",
      payload: { jobId: "source", automated: true },
    }),
  ).toEqual([expect.stringMatching(/capacity changed/)]);
  expect(
    admissionReasons({
      kind: "media",
      payload: { jobId: "source", automated: false },
    }),
  ).toEqual([]);
});
import { unpublishedAutomatedClips } from "../server/automation-policy";
it("downloadable local drafts consume backlog across days without a publishing account and disabled monitoring is never auto-enabled", () => {
  const root = mkdtempSync(path.join(tmpdir(), "capy-c3-local-"));
  roots.push(root);
  process.env.CAPY_DATA_DIR = root;
  resetSettingsCache();
  watch().mutate((f) =>
    addChannel(
      f,
      {
        id: "creator",
        name: "Creator",
        url: "https://youtube.com/channel/creator/videos",
      },
      [],
      { now: new Date(1000) },
    ),
  );
  watch().mutate((f) => ({
    ...f,
    channels: f.channels.map((c) => ({ ...c, enabled: false })),
  }));
  const p = saveCreatorPolicy("creator", {
    ...DEFAULT_CREATOR_POLICY,
    mode: "automatic_drafts",
    minDurationSec: 10,
  });
  expect(watch().get().channels[0]).toMatchObject({
    enabled: false,
    settings: { minVideoSec: 10, clips: 3 },
  });
  runtimeStore().put("automation-jobs", "old-local", {
    channelId: "creator",
    recipeId: p.recipeId,
  });
  runtimeStore().put("legacy-jobs", "old-local", {
    clips: Array.from({ length: 6 }, (_, n) => ({
      n,
      render: { status: "done" },
    })),
  });
  expect(unpublishedAutomatedClips()).toBe(6);
  expect(
    planCreatorWork({
      ...input("new-day"),
      policy: { ...DEFAULT_CREATOR_POLICY, mode: "automatic_drafts" },
      capacity: {
        ...input("new-day").capacity,
        unpublished: unpublishedAutomatedClips(),
      },
    }).kind,
  ).toBe("defer");
});

it("a channel without saved options may post to the connected accounts it is clipped for", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "capy-unsaved-policy-"));
  roots.push(root);
  process.env.CAPY_DATA_DIR = root;
  resetSettingsCache();
  watch().mutate((f) =>
    addChannel(
      f,
      { id: "fresh", name: "Fresh", url: "https://youtube.com/channel/fresh/videos" },
      [],
      { now: new Date(1000) },
    ),
  );
  expect(creatorPolicy("fresh").destinationAccountIds).toEqual(["local-drafts"]);
  saveAccount("youtube", {
    account: { id: "dest", name: "Fixture" },
    tokens: { accessToken: "fixture", expiresAt: Date.now() + 3600000 },
    autoPost: false,
  });
  const p = creatorPolicy("fresh");
  expect(p).toMatchObject({
    mode: "automatic_drafts",
    requireModelReview: true,
    destinationAccountIds: ["local-drafts", "dest"],
  });
  expect(p.recipeId).toBeUndefined();
  expect((await automationHealth()).policies.fresh?.destinationAccountIds).toEqual([
    "local-drafts",
    "dest",
  ]);
  // saved options still win
  saveCreatorPolicy("fresh", { ...policy, destinationAccountIds: [] });
  expect(creatorPolicy("fresh").destinationAccountIds).toEqual([]);
});
it("only uploads from the last 24 hours are clipped, judged by the real upload time when known", () => {
  const hour = 3600000;
  const at = (c: Partial<ReturnType<typeof input>["candidate"]> & { publishedAt?: number }, now: number) =>
    planCreatorWork({ ...input("v"), candidate: { ...input("v").candidate, ...c }, now }).kind;
  const now = 100 * hour;
  // found just now, but uploaded two days ago: too old
  expect(at({ foundAt: now, publishedAt: now - 48 * hour }, now)).toBe("skip");
  expect(at({ foundAt: now, publishedAt: now - 2 * hour }, now)).not.toBe("skip");
  // no upload time (no reading account): when capy first saw it
  expect(at({ foundAt: now - 25 * hour }, now)).toBe("skip");
  expect(at({ foundAt: now - hour }, now)).not.toBe("skip");
});
