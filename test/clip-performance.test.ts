import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runtimeStore } from "../server/db/runtime";
import { publicationFixture } from "./publication-fixtures";
import {
  decide,
  hashManifest,
  buildPublishPackage,
} from "../server/publication-policy";
import { upsertForRender } from "../server/queue";
import {
  createDelivery,
  updateDelivery,
  listDeliveryAttributions,
} from "../server/delivery-store";
import {
  getPublicationAttribution,
  capturePublicationAttribution,
} from "../server/publication-attribution";
import {
  captureRenderInputs,
  recordSuccessfulRender,
  getRenderProof,
} from "../server/render-attribution";
import {
  createPerformanceService,
  pacificDay,
  purgePublicationMetrics,
} from "../server/performance";
import { DEFAULT_CREATOR_POLICY } from "../lib/creator-policy";
import { saveCreatorPolicy } from "../server/automation-policy";
import { DEFAULT_SETTINGS, type JobState } from "../lib/types";
let root: string;
let time = Date.parse("2026-10-10T12:00:00Z");
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "capy-performance-"));
  process.env.CAPY_DATA_DIR = root;
  time = Date.parse("2026-10-10T12:00:00Z");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function entry() {
  const files = publicationFixture();
  return decide(
    upsertForRender(
      [],
      {
        publicationFiles: files,
        jobId: "J",
        n: 1,
        start: 0,
        end: 30,
        clipTitle: "clip",
        videoUrl: "/v",
      },
      ["youtube"],
      new Date(time),
    )[0]!,
    false,
    new Date(time),
  );
}
function published() {
  const e = entry(),
    d = createDelivery(e);
  updateDelivery(d.id, (x) => ({
    ...x,
    state: "public",
    visibility: "public",
    publicationIds: ["remote-1"],
    publishedAt: time - 10 * 86400000,
    thumbnail: { status: "not-requested" },
  }));
  return e;
}
const analytics = (
  rows: unknown[][] = [],
  names = [
    "day",
    "views",
    "engagedViews",
    "estimatedMinutesWatched",
    "averageViewDuration",
    "averageViewPercentage",
  ],
) => ({ columnHeaders: names.map((name) => ({ name })), rows });
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
function service(
  o: {
    views?: unknown;
    rows?: unknown[][];
    status?: number;
    item?: boolean;
    scope?: string;
    fetch?: typeof fetch;
  } = {},
) {
  let principal = {
    id: "fixture-account",
    platform: "youtube" as const,
    clientId: "local-client",
    epoch: "one",
    connected: true,
    scope: o.scope ?? "https://www.googleapis.com/auth/yt-analytics.readonly",
  };
  const calls: string[] = [];
  const s = createPerformanceService({
    store: runtimeStore(),
    now: () => time,
    destination: () => principal,
    deliveries: () => listDeliveryAttributions(),
    attribution: getPublicationAttribution,
    token: async () => "fixture",
    fetch:
      o.fetch ??
      ((async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("youtubeanalytics"))
          return reply(analytics(o.rows), o.status);
        return reply({
          items:
            o.item === false
              ? []
              : [
                  {
                    id: "remote-1",
                    snippet: { channelId: "fixture-account" },
                    statistics: { viewCount: o.views ?? "0", likeCount: "4" },
                    status: { privacyStatus: "public" },
                  },
                ],
        });
      }) as typeof fetch),
  });
  return {
    s,
    calls,
    setPrincipal: (p: Partial<typeof principal>) => {
      principal = { ...principal, ...p };
    },
  };
}
it("missing_metrics_are_not_zero", async () => {
  published();
  const { s } = service({ views: "0" });
  const result = await s.refreshPublicationMetrics("fixture-account");
  expect(result.publications[0]!.metrics.views).toMatchObject({
    availability: "available",
    value: 0,
    source: "youtube-data",
    window: { kind: "lifetime" },
  });
  expect(result.publications[0]!.metrics.comments).toMatchObject({
    availability: "unavailable",
    reason: "not-returned",
  });
  expect(result.publications[0]!.metrics.engagedViews).toMatchObject({
    availability: "unavailable",
    reason: "delayed-or-limited",
  });
});
it.each(["", "not-a-number", null])(
  "malformed value %s is unavailable rather than zero",
  async (views) => {
    published();
    const { s } = service({
      views,
      fetch: (async (input) =>
        String(input).includes("youtubeanalytics")
          ? reply(analytics())
          : reply({
              items: [
                {
                  id: "remote-1",
                  snippet: { channelId: "fixture-account" },
                  statistics: { viewCount: views },
                },
              ],
            })) as typeof fetch,
    });
    expect(
      (await s.refreshPublicationMetrics("fixture-account")).publications[0]!
        .metrics.views.availability,
    ).toBe("unavailable");
  },
);
it("view totals, engaged views and raw watched percentages remain distinct", async () => {
  published();
  const { s } = service({
    views: "100",
    rows: [["2026-10-08", 10, 7, 3, 18, 125]],
  });
  const row = (await s.refreshPublicationMetrics("fixture-account"))
    .publications[0]!;
  expect(row.metrics.views).toMatchObject({ value: 100 });
  expect(row.metrics.analyticsViews).toMatchObject({ value: 10 });
  expect(row.metrics.engagedViews).toMatchObject({ value: 7 });
  expect(row.metrics.averageViewPercentage).toMatchObject({ value: 125 });
  expect(row.metrics.averageViewPercentage).toMatchObject({
    window: {
      kind: "calendar",
      coverage: "unknown",
      timezone: "America/Los_Angeles",
    },
  });
});
it("failed refresh keeps dated previous values and records availability separately", async () => {
  published();
  const good = service({
    views: "12",
    rows: [["2026-10-08", 10, 7, 3, 18, 50]],
  });
  await good.s.refreshPublicationMetrics("fixture-account");
  const first = time;
  time += 6 * 3600000;
  const bad = service({ views: "9", status: 403 });
  const row = (await bad.s.refreshPublicationMetrics("fixture-account"))
    .publications[0]!;
  expect(row.metrics.views).toMatchObject({ value: 9 });
  expect(row.metrics.engagedViews).toMatchObject({
    availability: "unavailable",
    lastAvailable: { value: 7, measuredAt: first },
  });
});
it("missing permission never calls analytics, missing resource never becomes zero", async () => {
  published();
  const { s, calls } = service({ scope: "", item: false });
  const row = (await s.refreshPublicationMetrics("fixture-account"))
    .publications[0]!;
  expect(calls.some((u) => u.includes("youtubeanalytics"))).toBe(false);
  expect(row.metrics.views.availability).toBe("unavailable");
  expect(row.metrics.engagedViews).toMatchObject({ reason: "scope-missing" });
});
it("reordered report headers are read by metric name without local aggregation", async () => {
  published();
  const { s } = service({
    fetch: (async (input) =>
      String(input).includes("youtubeanalytics")
        ? reply(
            analytics(
              [[8, "2026-10-08", 40]],
              ["engagedViews", "day", "averageViewPercentage"],
            ),
          )
        : reply({
            items: [
              {
                id: "remote-1",
                snippet: { channelId: "fixture-account" },
                statistics: { viewCount: "11" },
              },
            ],
          })) as typeof fetch,
  });
  const row = (await s.refreshPublicationMetrics("fixture-account"))
    .publications[0]!;
  expect(row.metrics.engagedViews).toMatchObject({ value: 8 });
  expect(row.metrics.estimatedMinutesWatched.availability).toBe("unavailable");
});
it("destination changes during a held response cannot save or return foreign metrics", async () => {
  published();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const f = (async (input) => {
    await held;
    return reply(
      String(input).includes("youtubeanalytics")
        ? analytics()
        : {
            items: [
              {
                id: "remote-1",
                snippet: { channelId: "fixture-account" },
                statistics: { viewCount: "88" },
              },
            ],
          },
    );
  }) as typeof fetch;
  const { s, setPrincipal } = service({ fetch: f });
  const request = s.refreshPublicationMetrics("fixture-account");
  await Promise.resolve();
  setPrincipal({ id: "other", epoch: "two" });
  release();
  const result = await request;
  expect(result.status).toBe("unavailable");
  expect(result.publications[0]!.metrics.views.availability).toBe(
    "unavailable",
  );
  expect(runtimeStore().list("publication-metrics")).toHaveLength(0);
});
it("previous cached values cannot cross a destination identity replacement", async () => {
  published();
  const { s, setPrincipal } = service({ views: "12" });
  await s.refreshPublicationMetrics("fixture-account");
  setPrincipal({ id: "other", epoch: "replacement" });
  expect(
    s.publicationMetrics("fixture-account").publications[0]!.metrics.views
      .availability,
  ).toBe("unavailable");
});
it("exact selected thumbnail versions stay immutable after an unattached local edit", () => {
  const e = entry(),
    { packageHash: _, ...body } = e.publishPackage!;
  const first = buildPublishPackage({
    ...body,
    thumbnail: {
      revision: "published-revision",
      designId: "design-one",
      versionId: "version-A",
      checksum: "a".repeat(64),
    },
  });
  e.publishPackage = first;
  const snapshot = capturePublicationAttribution(e, first);
  runtimeStore().put("thumbnails", "design-one", {
    selectedVersionId: "version-B",
    checksum: "b".repeat(64),
  });
  expect(getPublicationAttribution(first.packageHash)?.thumbnail).toEqual(
    snapshot.thumbnail,
  );
  expect(snapshot.thumbnail?.versionId).toBe("version-A");
  expect(capturePublicationAttribution(e, first)).toEqual(snapshot);
});
it("deletion fences held refresh and preserves local publishing history", async () => {
  published();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { s } = service({
    fetch: (async () => {
      await held;
      return reply({ items: [] });
    }) as typeof fetch,
  });
  const request = s.refreshPublicationMetrics("fixture-account");
  await Promise.resolve();
  s.purgePublicationMetrics("fixture-account");
  release();
  await request;
  expect(runtimeStore().list("publication-metrics")).toHaveLength(0);
  expect(runtimeStore().list("deliveries")).toHaveLength(1);
  expect(runtimeStore().list("publication-attributions")).toHaveLength(1);
});
it("cache expiry and scoped purge remove metrics but preserve media, recipes and audit", async () => {
  published();
  const { s } = service({ views: "8" });
  await s.refreshPublicationMetrics("fixture-account");
  runtimeStore().put("publication-metrics", "foreign", {
    accountId: "other",
    expiresAt: time + 99 * 86400000,
    metrics: {},
  });
  time += 31 * 86400000;
  expect(
    s.publicationMetrics("fixture-account").publications[0]!.metrics.views
      .availability,
  ).toBe("unavailable");
  purgePublicationMetrics("fixture-account");
  expect(runtimeStore().get("publication-metrics", "foreign")).toBeDefined();
  expect(runtimeStore().list("deliveries")).toHaveLength(1);
});
it("manual remote thumbnail change preserves original exact selected version and marks uncertainty", async () => {
  const e = published(),
    { s } = service();
  const before = getPublicationAttribution(e.publishPackage!.packageHash);
  s.recordRemoteChange("fixture-account", "remote-1", { kind: "thumbnail" });
  const row = s.publicationMetrics("fixture-account").publications[0]!;
  expect(row.remoteChanges).toEqual([
    expect.objectContaining({ kind: "thumbnail", reportedAt: time }),
  ]);
  expect(row.thumbnailAttribution).toBe("uncertain");
  expect(getPublicationAttribution(e.publishPackage!.packageHash)).toEqual(
    before,
  );
});
it("unpublished and unsupported destinations have explicit availability and no provider call", async () => {
  const e = entry();
  createDelivery(e);
  const { s, calls } = service();
  expect(
    (await s.refreshPublicationMetrics("fixture-account")).publications[0]!
      .metrics.views,
  ).toMatchObject({ reason: "not-published" });
  expect(calls).toHaveLength(0);
});
it("Pacific analytics dates handle DST instead of UTC isoDay", () => {
  expect(pacificDay(Date.parse("2026-03-08T07:30:00Z"))).toBe("2026-03-07");
  expect(pacificDay(Date.parse("2026-11-01T08:30:00Z"))).toBe("2026-11-01");
});
function job(): JobState {
  return {
    id: "J",
    videoId: "source-video",
    url: "https://youtube.com/watch?v=source-video",
    status: "ready",
    stage: "done",
    stageStartedAt: time,
    createdAt: time,
    settings: { ...DEFAULT_SETTINGS, count: 3 },
    estimate: {} as JobState["estimate"],
    clips: [],
    log: [],
    dir: "fixture",
    automation: { channelId: "creator-one", channelName: "Creator" },
  };
}
it("compare_only_attributed_versions: successful future render binds recipe before later settings changes", () => {
  const e = entry(),
    j = job();
  const policy = saveCreatorPolicy("creator-one", {
    ...DEFAULT_CREATOR_POLICY,
    mode: "automatic_drafts",
  });
  j.automation!.recipeId = policy.recipeId;
  runtimeStore().put("automation-jobs", "J", {
    channelId: "creator-one",
    recipeId: policy.recipeId,
  });
  const c = { n: 1, start: 0, end: 30 } as JobState["clips"][number];
  const input = captureRenderInputs(j, c);
  j.settings.style = "clean";
  saveCreatorPolicy("creator-one", {
    ...policy,
    editTemplate: "clean-portrait-v1",
  });
  recordSuccessfulRender(input, e.publicationFiles!.file, {
    checksum: e.publishPackage!.artifact.checksum,
    durationUs: 30000000,
  });
  const snapshot = capturePublicationAttribution(e, e.publishPackage!);
  expect(snapshot.recipe).toMatchObject({
    state: "attributed",
    recipeId: policy.recipeId,
    settings: { style: "bold" },
  });
  expect(snapshot.outputDurationUs).toBe(30000000);
  expect(
    getRenderProof("J", 1, e.publishPackage!.artifact.checksum)?.input.settings
      .style,
  ).toBe("bold");
  expect(capturePublicationAttribution(e, e.publishPackage!)).toEqual(snapshot);
});
it("failed or changed render never records successful proof and historical links remain unattributed", () => {
  const e = entry(),
    j = job(),
    c = { n: 1, start: 0, end: 30 } as JobState["clips"][number];
  const input = captureRenderInputs(j, c);
  expect(() =>
    recordSuccessfulRender(input, e.publicationFiles!.file, {
      checksum: "f".repeat(64),
      durationUs: 30000000,
    }),
  ).toThrow(/checksum/i);
  expect(
    getRenderProof("J", 1, e.publishPackage!.artifact.checksum),
  ).toBeUndefined();
  expect(capturePublicationAttribution(e, e.publishPackage!).recipe.state).toBe(
    "unattributed",
  );
});
it("recipe summaries are exact raw rows, no ranking, lift or performance-driven adoption", async () => {
  published();
  const { s } = service();
  await s.refreshPublicationMetrics("fixture-account");
  const summary = await s.summarizeRecipePerformance("f".repeat(64));
  expect(summary.publications).toEqual([]);
  expect(summary.comparison).toMatchObject({ availability: "unavailable" });
  expect(summary.suggestions.map((x) => x.axis)).toEqual([
    "creator",
    "topic",
    "length",
    "template",
  ]);
  expect(
    summary.suggestions.every(
      (x) => x.source === "capy-local" && x.adoption === "manual",
    ),
  ).toBe(true);
});
it.each([200, 403])(
  "bounded continuation covers every ID including failed caches and expiry (HTTP %s)",
  async (status) => {
    published();
    const delivery = runtimeStore().list<{ id: string }>("deliveries")[0]!
      .value;
    const ids = Array.from({ length: 51 }, (_, n) => `publication-${n}`);
    updateDelivery(delivery.id, (x) => ({ ...x, publicationIds: ids }));
    const batches: string[][] = [];
    const { s } = service({
      scope: "",
      fetch: (async (input) => {
        const u = new URL(String(input));
        batches.push(u.searchParams.get("id")!.split(","));
        return reply({ items: [] }, status);
      }) as typeof fetch,
    });
    await s.refreshPublicationMetrics("fixture-account");
    expect(batches[0]).toHaveLength(50);
    time += 1000;
    await s.refreshPublicationMetrics("fixture-account");
    expect(batches[1]).toContain("publication-50");
    expect(runtimeStore().list("publication-metrics")).toHaveLength(51);
    time += 31 * 86400000;
    await s.refreshPublicationMetrics("fixture-account");
    time += 1000;
    await s.refreshPublicationMetrics("fixture-account");
    expect(new Set(batches.slice(2).flat()).size).toBe(51);
  },
);
