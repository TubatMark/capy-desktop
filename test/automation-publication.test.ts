import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CREATOR_POLICY } from "../lib/creator-policy";
import type { QueueEntry } from "../lib/types";
import { runtimeStore } from "../server/db/runtime";
import { saveCreatorPolicy } from "../server/automation-policy";
import { resetSettingsCache, saveSettings } from "../server/settings";
import { queueGroup } from "../lib/queue-source";
import { publicationFixture } from "./publication-fixtures";
import {
  buildPublishPackage,
  decide,
  eligibility,
  hashFile,
  mediaOptions,
  hashManifest,
  PUBLICATION_POLICY_VERSION,
} from "../server/publication-policy";
import { approve, queue, resetQueueCache } from "../server/queue";
import { tick } from "../server/poster";
import type { PostJob } from "../server/platforms/types";
import {
  thumbnailReviewManifest,
  type ThumbnailStudioDocument,
} from "../lib/thumbnails";

const roots: string[] = [];
afterEach(() => {
  resetQueueCache();
  resetSettingsCache();
  delete process.env.CAPY_DATA_DIR;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(fallback: "none" | "source_frame") {
  const root = mkdtempSync(path.join(tmpdir(), "capy-c3-publication-"));
  roots.push(root);
  process.env.CAPY_DATA_DIR = root;
  resetSettingsCache();
  resetQueueCache();
  const files = {
    ...publicationFixture(),
    thumbFile: path.join(root, "default.jpg"),
  };
  writeFileSync(files.thumbFile, "fixture source-frame bytes");
  const p = saveCreatorPolicy("creator", {
    ...DEFAULT_CREATOR_POLICY,
    mode: "automatic_drafts",
    destinationAccountIds: ["fixture-account"],
    requireModelReview: false,
    optionalThumbnailFallback: fallback,
  });
  const store = runtimeStore();
  store.put("automation-jobs", "auto-job", {
    channelId: "creator",
    recipeId: p.recipeId,
  });
  const checksum = hashFile(files.file)!;
  // Measured quality is independently exercised with real ffmpeg in media-quality.test.ts.
  store.put("media-quality", checksum, {
    artifactId: "auto-job:1:youtube",
    checksum,
    revision: 0,
    reviewVersion: "deterministic-media-v1",
    policy: {
      aspect: "portrait",
      requireAudio: false,
      maxBlackRatio: p.maxBlackRatio,
      maxFrozenRatio: p.maxFrozenRatio,
    },
    passed: true,
    at: Date.now(),
    modelReview: { status: "not_requested", reason: "technical only" },
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
  });
  const e: QueueEntry = {
    key: "auto-job:1:youtube",
    jobId: "auto-job",
    n: 1,
    platform: "youtube",
    status: "review",
    clipTitle: "Fixture",
    text: { title: "Fixture" },
    attempts: 0,
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    publicationFiles: files,
  };
  return { e, files, p, store };
}
async function upload(
  e: QueueEntry,
  files: { file: string; thumbFile?: string },
) {
  const now = new Date();
  queue().mutate(() => [{ ...e, status: "scheduled", slotAt: now.getTime() }]);
  const sent: PostJob[] = [];
  await tick({
    now: () => now,
    paused: () => false,
    lock: () => "held",
    audienceTz: () => "UTC",
    token: async () => "fixture",
    fileFor: async () => files,
    post: async (_entry, job) => {
      sent.push(job);
      return { kind: "posted", id: "fixture" };
    },
  });
  return sent;
}
it("optional none omits guessed thumbnails from both approved manifest and actual upload; current policy changes invalidate approval", async () => {
  const { e, files, p } = fixture("none");
  const approved = decide(e, false, new Date());
  expect(approved.publishPackage?.thumbnail).toBeUndefined();
  expect(approved.publicationFiles?.thumbFile).toBeUndefined();
  expect(eligibility(approved).allowed).toBe(true);
  expect((await upload(approved, files)).map((j) => j.thumbFile)).toEqual([
    undefined,
  ]);
  saveCreatorPolicy("creator", { ...p, dailyClipCap: p.dailyClipCap - 1 });
  expect(eligibility(approved).reasons).toContain("Publication policy changed");
});
it.each(["none", "source_frame"] as const)(
  "optional %s preserves an explicitly selected immutable design and its exact source frame at actual upload",
  async (fallback) => {
    const { e, files, p, store } = fixture(fallback);
    store.put("legacy-jobs", e.jobId!, { clips: [{ n: 1, render: { status: "done", file: files.file } }] });
    const sourceRow = store.get("legacy-jobs", e.jobId!)!;
    const sourceIdentity = {
      kind: "legacy" as const,
      jobId: e.jobId!,
      clipN: 1,
      revision: sourceRow.revision,
      renderChecksum: hashFile(files.file)!,
    };
    const frame = {
      id: "frame",
      assetId: "source",
      sourceUs: 0,
      renderUs: 0,
      checksum: hashFile(files.thumbFile)!,
    };
    const selected: ThumbnailStudioDocument = {
      id: "selected",
      editRevision: 0,
      name: "Selected fixture",
      layout: "minimal",
      aspectPreset: "portrait",
      layers: [],
      versions: [],
      provenance: {
        provider: "local",
        model: "fixture",
        prompt: "fixture",
        capability: "local-composition",
      },
      imageGeneration: { status: "unavailable", accounting: "local" },
      sourceIdentity,
      renderChecksum: sourceIdentity.renderChecksum,
      sourceFrames: [frame],
      generationState: "ready",
      reviewState: "pending",
    };
    store.put("thumbnails", "selected", selected);
    const row = store.get("thumbnails", "selected")!;
    e.publishPackage = buildPublishPackage({
      id: "selected-pkg",
      artifact: { id: e.key, checksum: sourceIdentity.renderChecksum },
      text: e.text,
      textHash: hashManifest(e.text),
      platform: e.platform,
      accountId: "fixture-account",
      policyVersion: PUBLICATION_POLICY_VERSION,
      mediaOptionsHash: mediaOptions(e),
      deliveryOptions: { mode: "public", privacyPolicy: "public" },
      thumbnail: {
        revision: `selected:${row.revision}:jpg`,
        checksum: frame.checksum,
        designId: "selected",
        versionId: "jpg",
        sourceIdentity,
        sourceFrame: frame,
      },
    });
    const approved = decide(e, false, new Date());
    store.put("thumbnail-attachments", approved.publishPackage!.packageHash, {
      editRevision: row.revision,
      checksum: frame.checksum,
      versionId: "jpg",
    });
    expect(eligibility(approved).reasons).toEqual([]);
    expect((await upload(approved, files)).map((j) => j.thumbFile)).toEqual([
      files.thumbFile,
    ]);
    saveCreatorPolicy("creator", { ...p, thumbnailRequired: true });
    const required = decide(approved, false, new Date());
    store.put("thumbnail-attachments", required.publishPackage!.packageHash, {
      editRevision: row.revision,
      checksum: frame.checksum,
      versionId: "jpg",
    });
    expect(eligibility(required).reasons).toContain(
      "Required thumbnail is waiting for explicit approval",
    );
    const historical = { ...selected, editRevision: row.revision };
    store.put("thumbnail-reviews", `selected:${row.revision}`, {
      state: "approved",
      digest: hashManifest(thumbnailReviewManifest(historical)),
    });
    expect(eligibility(required).reasons).toEqual([]);
    store.put("thumbnail-history", `selected:${row.revision}`, historical);
    store.put(
      "thumbnails",
      "selected",
      {
        ...selected,
        name: "Unattached newer edit",
        layers: [
          {
            id: "new",
            kind: "text",
            text: "New",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
      },
      row.revision + 1,
    );
    expect(eligibility(required).reasons).toEqual([]);
    store.put("thumbnail-reviews", `selected:${row.revision}`, {
      state: "approved",
      digest: "stale",
    });
    expect(eligibility(required).reasons).toContain(
      "Required thumbnail is waiting for explicit approval",
    );
  },
);
it("source-frame fallback blocks filename-only thumbnails through the shared gate and never calls upload", async () => {
  const { e, files } = fixture("source_frame");
  const approved = decide(e, false, new Date());
  expect(eligibility(approved).reasons).toContain(
    "Configured source-frame fallback has not been attached with exact provenance",
  );
  expect(await upload(approved, files)).toEqual([]);
  expect(queue().list()[0]!.status).toBe("review");
});
it("auto-scheduling: a clip with an OK review is scheduled without a human decision, only while the owner's switch is on", async () => {
  const { e } = fixture("none");
  // a two-AI review, as the content review now produces (each opinion travels inside the approved package)
  const review = {
    verdict: "ok" as const,
    summary: "Fine",
    issues: [],
    at: 1,
    opinions: [
      { by: "claude" as const, verdict: "ok" as const, summary: "Fine", issues: [], at: 1 },
      { by: "codex" as const, verdict: "caution" as const, summary: "Check", issues: [], at: 1, unavailable: false },
    ],
  };
  const waiting = { ...e, aiReview: review };
  const { entries, scheduled } = approve([waiting], "", undefined, {
    group: queueGroup(waiting),
    automatic: true,
    audienceTz: "UTC",
    now: new Date(),
  });
  expect(scheduled).toHaveLength(1);
  const s = entries[0]!;
  expect(s).toMatchObject({ status: "scheduled" });
  expect(s.publicationDecision).toBeUndefined();
  expect(s.autoScheduledAt).toBeTypeOf("number");
  expect(s.history.at(-1)?.msg).toMatch(/Scheduled automatically/);
  expect(eligibility(s).allowed).toBe(true);
  // turning the switch off holds back what it already scheduled
  saveSettings({ autoSchedule: false });
  expect(eligibility(s).reasons).toContain("Publication decision missing or stale");
  saveSettings({ autoSchedule: true });
  const auto = (verdict: "caution" | "block") =>
    approve([{ ...e, aiReview: { ...review, verdict, opinions: undefined } }], "", undefined, {
      group: queueGroup(e),
      automatic: true,
      audienceTz: "UTC",
      now: new Date(),
    }).scheduled;
  // "check this" goes out while the owner accepts it (the default)...
  expect(auto("caution")).toHaveLength(1);
  // ...and waits when they don't
  saveSettings({ autoScheduleCaution: false });
  expect(auto("caution")).toHaveLength(0);
  saveSettings({ autoScheduleCaution: true });
  // "don't post" never goes out automatically
  expect(auto("block")).toHaveLength(0);
});
