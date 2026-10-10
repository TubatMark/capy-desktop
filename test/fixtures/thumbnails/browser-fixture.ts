import path from "node:path";
import { DEFAULT_SETTINGS } from "../../../lib/types";
import { validateLegacy } from "../../../server/db/legacy-validation";
import { mkdir } from "node:fs/promises";
import { run } from "../../../src/exec";
import { checksum } from "../../../server/studio/assets";
import { extractFrameCandidates } from "../../../src/thumbnails/frames";
import { composeThumbnail } from "../../../src/thumbnails/compose";
import { buildThumbnailBrief } from "../../../src/thumbnails/brief";
import { thumbnailDependencies } from "../../../server/thumbnails";
import {
  buildPublishPackage,
  hashManifest,
} from "../../../server/publication-policy";
const deps = thumbnailDependencies(),
  directory = path.join(deps.root, "thumbnail-browser"),
  file = path.join(directory, "source.mp4");
await mkdir(directory, { recursive: true });
await run("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=6:duration=2",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-y",
  file,
]);
const renderChecksum = await checksum(file),
  source = {
    kind: "legacy" as const,
    jobId: "thumbnail-browser",
    clipN: 1,
    revision: 4,
    renderChecksum,
  };
deps.store.put(
  "legacy-jobs",
  source.jobId,
  {
    id: source.jobId,
    videoId: "fixture",
    url: "https://example.invalid/fixture",
    dir: "thumbnail-browser",
    status: "ready",
    stage: "done",
    stageStartedAt: 1,
    createdAt: 1,
    settings: { ...DEFAULT_SETTINGS, autoPost: false },
    estimate: { stageRemaining: 0, totalRemaining: 0, progress: 1 },
    log: [],
    clips: [
      {
        n: 1,
        start: 0,
        end: 2,
        title: "Browser source",
        hook: "A fixture",
        reason: "Owned local thumbnail fixture",
        score: 1,
        selected: false,
        render: { status: "done", file },
      },
    ],
  },
  4,
);
validateLegacy(
  "legacy-jobs",
  source.jobId,
  deps.store.get("legacy-jobs", source.jobId)!.value,
);
const frames = await extractFrameCandidates(
  {
    kind: "legacy",
    clipId: `${source.jobId}:1`,
    revision: 4,
    assetId: `${source.jobId}:source`,
    path: file,
    checksum: renderChecksum,
  },
  new AbortController().signal,
  { directory: path.join(directory, "frames") },
);
for (const frame of frames)
  deps.store.put("thumbnail-frames", frame.id, {
    ...frame,
    sourceIdentity: source,
  });
for (let variant = 0; variant < 3; variant++) {
  const frame = frames[variant % frames.length]!,
    brief = buildThumbnailBrief({
      headline: "REAL SOURCE",
      aspect: "landscape",
      variant,
      frames: [frame],
    }),
    composed = await composeThumbnail(
      { brief, frame, directory: path.join(directory, brief.layout) },
      new AbortController().signal,
    );
  deps.store.put("thumbnails", `browser-${brief.layout}`, {
    id: `browser-${brief.layout}`,
    name: brief.layout,
    sourceIdentity: source,
    legacyClipId: `${source.jobId}:1`,
    renderChecksum,
    sourceFrames: [
      {
        assetId: frame.assetId,
        sourceUs: frame.sourceUs,
        checksum: frame.checksum,
      },
    ],
    aspectPreset: "landscape",
    layout: brief.layout,
    layers: composed.layers,
    versions: composed.versions,
    provenance: {
      provider: "local",
      model: "none",
      prompt: brief.instructions,
      capability: "local-composition",
    },
    imageGeneration: {
      status: "unavailable",
      reason: "Fixture: image provider disabled",
      accounting: "local",
    },
    generationState: "ready",
    reviewState: "pending",
  });
}
const text = { title: "Browser source" },
  pkg = buildPublishPackage({
    id: "browser-package",
    artifact: { id: `${source.jobId}:1`, checksum: renderChecksum },
    text,
    textHash: hashManifest(text),
    platform: "youtube",
    accountId: "fixture-unconnected",
    policyVersion: "publication-v2",
    mediaOptionsHash: hashManifest({}),
    deliveryOptions: { mode: "public", privacyPolicy: "public" },
  });
deps.store.put("legacy-state", "queue", [
  {
    key: `${source.jobId}:1:youtube`,
    jobId: source.jobId,
    n: 1,
    platform: "youtube",
    status: "review",
    clipTitle: "Browser source",
    text,
    attempts: 0,
    history: [],
    createdAt: 1,
    updatedAt: 1,
    publicationFiles: { file },
    publishPackage: pkg,
  },
]);
deps.store.close();
