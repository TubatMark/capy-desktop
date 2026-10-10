import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, type JobState } from "../../../lib/types";
import { DEFAULT_CREATOR_POLICY } from "../../../lib/creator-policy";
import { publicationFixture } from "../../publication-fixtures";
import { saveAccount } from "../../../server/accounts";
import { runtimeStore } from "../../../server/db/runtime";
import { dataDir } from "../../../server/settings";
import { saveCreatorPolicy } from "../../../server/automation-policy";
import { upsertForRender } from "../../../server/queue";
import { decide } from "../../../server/publication-policy";
import { listDeliveryAttributions } from "../../../server/delivery-store";
import { DeliveryRecordSchema } from "../../../lib/delivery";
import {
  captureRenderInputs,
  measureRenderedAttribution,
  recordSuccessfulRender,
} from "../../../server/render-attribution";
import {
  getPublicationAttribution,
  capturePublicationAttribution,
} from "../../../server/publication-attribution";
import { createPerformanceService } from "../../../server/performance";
import { watch, addChannel } from "../../../server/watch";
import { run } from "../../../src/exec";
import { channelState } from "../../../server/channel";
const now = Date.now(),
  store = runtimeStore(),
  creator = "performance-creator";
mkdirSync(dataDir(), { recursive: true });
writeFileSync(
  path.join(dataDir(), "settings.json"),
  JSON.stringify({
    automationControls: {
      globalStop: true,
      monitorPaused: true,
      renderPaused: true,
      postPaused: true,
    },
  }),
);
const files = publicationFixture();
await run("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=6:duration=1",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-y",
  files.file,
]);
saveAccount("youtube", {
  clientId: "performance-fixture-client",
  account: { id: "fixture-account", name: "Performance fixture" },
  autoPost: false,
  tokens: {
    accessToken: "fixture",
    expiresAt: now + 86400000,
    scope:
      "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
  },
});
const policy = saveCreatorPolicy(creator, {
  ...DEFAULT_CREATOR_POLICY,
  mode: "automatic_drafts",
});
watch().mutate((f) =>
  f.channels.some((c) => c.id === creator)
    ? f
    : addChannel(
        f,
        {
          id: creator,
          name: "Performance creator",
          url: "https://example.invalid/owned-fixture",
        },
        [],
        { now: new Date(now) },
      ),
);
const job = {
  id: "performance-job",
  videoId: "performance-source",
  settings: { ...DEFAULT_SETTINGS, count: 3, autoPost: false },
  automation: {
    channelId: creator,
    channelName: "Performance creator",
    recipeId: policy.recipeId,
  },
} as JobState;
store.put("automation-jobs", job.id, {
  channelId: creator,
  recipeId: policy.recipeId,
});
const input = captureRenderInputs(job, {
  n: 1,
  start: 0,
  end: 1,
} as JobState["clips"][number]);
recordSuccessfulRender(
  input,
  files.file,
  await measureRenderedAttribution(files.file),
);
const entry = decide(
  upsertForRender(
    [],
    {
      publicationFiles: files,
      jobId: job.id,
      n: 1,
      start: 0,
      end: 1,
      clipTitle: "Performance fixture",
      videoUrl: "/v/performance-job",
    },
    ["youtube"],
    new Date(now),
  )[0]!,
  false,
  new Date(now),
);
// An observed historical fixture: never approve or dispatch an outbound delivery.
const attribution = capturePublicationAttribution(entry, entry.publishPackage!);
const delivery = DeliveryRecordSchema.parse({
  version: 1,
  generation: 0,
  checkpoint: 0,
  id: "9551dc38-e1d7-4ab6-9522-9ab70101c1ab",
  revision: 0,
  queueKey: entry.key,
  package: entry.publishPackage,
  attribution: {
    packageHash: attribution.packageHash,
    attributionHash: attribution.attributionHash,
  },
  phase: "publication-observed",
  attempts: 0,
  createdAt: now,
  updatedAt: now,
  state: "public",
  visibility: "public",
  publicationIds: ["performance-remote"],
  publishedAt: now - 3 * 86400000,
  thumbnail: { status: "not-requested" },
});
store.put("deliveries", delivery.id, delivery);
const service = createPerformanceService({
  store,
  now: () => now,
  destination: () => ({
    id: "fixture-account",
    platform: "youtube",
    clientId: "performance-fixture-client",
    epoch: "fixture",
    connected: true,
    scope: "https://www.googleapis.com/auth/yt-analytics.readonly",
  }),
  token: async () => "fixture",
  deliveries: () => listDeliveryAttributions(),
  attribution: getPublicationAttribution,
  fetch: (async (input) =>
    new Response(
      JSON.stringify(
        String(input).includes("youtubeanalytics")
          ? {
              columnHeaders: [
                { name: "engagedViews" },
                { name: "averageViewPercentage" },
              ],
              rows: [[7, 125]],
            }
          : {
              items: [
                {
                  id: "performance-remote",
                  snippet: { channelId: "fixture-account" },
                  statistics: { viewCount: "0", likeCount: "4" },
                },
              ],
            },
      ),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch,
});
await service.refreshPublicationMetrics("fixture-account");
await channelState(
  { refresh: true },
  {
    now: () => new Date(now),
    token: async () => "fixture",
    fetch: (async (input) =>
      new Response(
        JSON.stringify(
          String(input).includes("/channels?")
            ? {
                items: [
                  {
                    id: "fixture-account",
                    snippet: {
                      title: "Performance fixture",
                      description: "Owned local fixture",
                    },
                    statistics: {
                      subscriberCount: "10",
                      viewCount: "100",
                      videoCount: "1",
                    },
                  },
                ],
              }
            : { columnHeaders: [], rows: [] },
        ),
      )) as typeof fetch,
  },
);
writeFileSync(
  path.join(process.env.CAPY_STUDIO_TEST_ROOT!, "performance-fixture.json"),
  JSON.stringify({
    recipeId: policy.recipeId,
    packageHash: entry.publishPackage!.packageHash,
    deliveryId: delivery.id,
  }),
);
store.close();
