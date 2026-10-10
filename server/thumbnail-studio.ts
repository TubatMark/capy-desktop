import { randomUUID } from "node:crypto";
import { realpath, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  FrameCandidate,
  ThumbnailDesign,
  ThumbnailLayer,
  ThumbnailSourceRef,
  ThumbnailStudioDocument,
  ThumbnailExportOptions,
  ThumbnailExport,
  ThumbnailReviewAudit,
} from "../lib/thumbnails";
import {
  THUMBNAIL_DIMENSIONS,
  thumbnailReviewManifest,
} from "../lib/thumbnails";
import type { QueueEntry } from "../lib/types";
import type { PublishPackage } from "../lib/publication";
import { RevisionConflict } from "./db";
import { checksum } from "./studio/assets";
import {
  thumbnailDependencies,
  listThumbnailFrames,
  listThumbnails,
  generateThumbnails,
  resolveThumbnailSource,
  type ThumbnailDependencies,
} from "./thumbnails";
import { composeThumbnail, thumbnailLayers } from "../src/thumbnails/compose";
import {
  hashManifest,
  buildPublishPackage,
  hashFile,
} from "./publication-policy";
const fail = (message: string, status = 400) =>
  Object.assign(Error(message), { status });
const optionsSchema = z.strictObject({
  format: z.enum(["png", "jpg"]),
  aspect: z.enum(["landscape", "portrait", "square"]),
  text: z.boolean(),
});
const layerSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["image", "text", "shape"]),
  assetId: z.string().optional(),
  text: z.string().max(120).optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  color: z
    .string()
    .regex(/^[a-f0-9]{6}$/i)
    .optional(),
  fontSize: z.number().min(16).max(256).optional(),
  fontFamily: z
    .enum(["Arial", "Arial Bold", "DejaVu Sans", "DejaVu Sans Bold"])
    .optional(),
  crop: z
    .strictObject({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    })
    .optional(),
  textLayout: z.unknown().optional(),
});
function revision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw fail("Invalid thumbnail revision");
}
export function getThumbnail(
  id: string,
  editRevision?: number,
  deps = thumbnailDependencies(),
): ThumbnailStudioDocument {
  const row = deps.store.get<ThumbnailDesign>("thumbnails", id);
  if (!row) throw fail("Thumbnail not found", 404);
  const current = { ...row.value, editRevision: row.revision };
  if (editRevision === undefined || editRevision === row.revision)
    return reviewed(current, deps);
  revision(editRevision);
  const historic = deps.store.get<ThumbnailStudioDocument>(
    "thumbnail-history",
    `${id}:${editRevision}`,
  )?.value;
  if (!historic) throw fail("Thumbnail revision not found", 404);
  return reviewed(historic, deps);
}
function reviewed(
  doc: ThumbnailStudioDocument,
  deps: ThumbnailDependencies,
): ThumbnailStudioDocument {
  const audit = deps.store.get<ThumbnailReviewAudit>(
    "thumbnail-reviews",
    `${doc.id}:${doc.editRevision}`,
  )?.value;
  return doc.reviewState !== "stale" &&
    audit?.state === "approved" &&
    audit.digest === hashManifest(thumbnailReviewManifest(doc))
    ? { ...doc, reviewState: "approved" }
    : doc;
}
export async function approveThumbnail(
  id: string,
  editRevision: number,
  deps = thumbnailDependencies(),
): Promise<ThumbnailReviewAudit> {
  revision(editRevision);
  const doc = getThumbnail(id, editRevision, deps);
  await resolveThumbnailSource(doc.sourceIdentity, deps);
  const frame = frameFor(doc, deps);
  await verified(frame.path, frame.checksum, deps);
  const bg = doc.layers.find((l) => l.id === "background");
  if (bg?.kind === "image") {
    const asset = deps.store.get<{ path: string; checksum: string }>(
      "thumbnail-assets",
      bg.assetId!,
    )?.value;
    if (!asset || asset.checksum !== bg.assetId)
      throw fail("Saved background unavailable");
    await verified(asset.path, asset.checksum, deps);
  }
  const selected = [
    doc.versions.filter((v) => v.format === "png").at(-1),
    doc.versions.filter((v) => v.format === "jpg").at(-1),
  ];
  if (selected.some((v) => !v)) throw fail("Thumbnail versions unavailable");
  for (const version of selected)
    await verified(version!.path, version!.checksum, deps);
  const audit: ThumbnailReviewAudit = {
    thumbnailId: id,
    editRevision,
    digest: hashManifest(thumbnailReviewManifest(doc)),
    state: "approved",
    at: Date.now(),
    sourceIdentity: doc.sourceIdentity,
    versionChecksums: selected.map((v) => ({
      id: v!.id,
      checksum: v!.checksum,
    })),
  };
  return deps.store.transaction(() => {
    const source = doc.sourceIdentity;
    const currentSource =
      source.kind === "project"
        ? deps.store.get("projects", source.projectId)
        : deps.store.get("legacy-jobs", source.jobId);
    if (currentSource?.revision !== source.revision)
      throw fail("Thumbnail footage is stale", 409);
    const key = `${id}:${editRevision}`,
      prior = deps.store.get<ThumbnailReviewAudit>("thumbnail-reviews", key);
    if (prior?.value.digest === audit.digest) return prior.value;
    if (
      hashManifest(
        thumbnailReviewManifest(getThumbnail(id, editRevision, deps)),
      ) !== audit.digest
    )
      throw fail("Thumbnail changed during review", 409);
    deps.store.save("thumbnail-reviews", key, audit, prior?.revision ?? 0);
    return audit;
  });
}

/** Archive the previous edit revision before B5 persists a staleness transition. */
export function listStudioThumbnails(
  source?: ThumbnailSourceRef,
  deps = thumbnailDependencies(),
): ThumbnailStudioDocument[] {
  return deps.store.transaction(() => {
    const before = deps.store
      .list<ThumbnailDesign>("thumbnails")
      .map((row) => ({ ...row.value, editRevision: row.revision }));
    const updated = listThumbnails(source, deps);
    for (const old of before) {
      const row = deps.store.get("thumbnails", old.id);
      if (row?.revision !== old.editRevision)
        deps.store.put(
          "thumbnail-history",
          `${old.id}:${old.editRevision}`,
          old,
        );
    }
    const regeneratedIds = new Set(
      deps.store
        .list<ThumbnailRegeneration>("thumbnail-regeneration")
        .flatMap(
          (row) =>
            (
              deps.queue.get(row.value.jobId)?.checkpoint.designs as
                ThumbnailDesign[] | undefined
            )?.map((doc) => doc.id) ?? [],
        ),
    );
    return updated
      .filter((doc) => !regeneratedIds.has(doc.id))
      .map((doc) => getThumbnail(doc.id, undefined, deps));
  });
}

export function thumbnailHistory(id: string, deps = thumbnailDependencies()) {
  const current = getThumbnail(id, undefined, deps);
  return [
    ...deps.store
      .list<ThumbnailStudioDocument>("thumbnail-history")
      .map((r) => r.value)
      .filter((d) => d.id === id),
    current,
  ].sort((a, b) => b.editRevision - a.editRevision);
}
async function verified(
  file: string,
  digest: string,
  deps: ThumbnailDependencies,
) {
  const root = await realpath(deps.root),
    actual = await realpath(file);
  if (
    !actual.startsWith(root + path.sep) ||
    (await checksum(actual)) !== digest
  )
    throw fail("Thumbnail asset bytes or path changed");
  return actual;
}
function frameFor(
  doc: ThumbnailDesign,
  deps: ThumbnailDependencies,
): FrameCandidate {
  const layer = doc.layers.find((l) => l.id === "source");
  const frame = listThumbnailFrames(doc.sourceIdentity, deps).find(
    (f) => f.id === layer?.assetId,
  );
  if (!frame)
    throw fail("Source frame does not belong to exact thumbnail footage");
  return frame;
}
function briefFor(doc: ThumbnailDesign, aspect = doc.aspectPreset) {
  return {
    version: 1 as const,
    layout: doc.layout,
    headline: doc.layers.find((l) => l.kind === "text")?.text ?? "",
    aspect,
    instructions: doc.provenance.prompt,
    sourceFrameIds: [doc.layers.find((l) => l.id === "source")!.assetId!],
  };
}
/** Reflow into each preset's intended composition and retain local visual edits. */
export function reflowThumbnail(
  doc: ThumbnailDesign,
  aspect: ThumbnailExportOptions["aspect"],
  frame: FrameCandidate,
): ThumbnailLayer[] {
  if (aspect === doc.aspectPreset) return structuredClone(doc.layers);
  const oldDefault = thumbnailLayers(briefFor(doc), frame),
    next = thumbnailLayers(briefFor(doc, aspect), frame),
    oldDim = THUMBNAIL_DIMENSIONS[doc.aspectPreset],
    newDim = THUMBNAIL_DIMENSIONS[aspect];
  return doc.layers.map((layer) => {
    const baseline = oldDefault.find((l) => l.id === layer.id),
      target = next.find((l) => l.id === layer.id);
    if (!baseline || !target)
      throw fail("Unsupported custom layer for aspect reflow");
    const out = {
      ...layer,
      ...Object.fromEntries(
        ["x", "y", "width", "height"].map((key) => {
          const k = key as "x" | "y" | "width" | "height";
          const ratio =
            k === "x" || k === "width"
              ? newDim.width / oldDim.width
              : newDim.height / oldDim.height;
          return [k, Math.round(target[k] + (layer[k] - baseline[k]) * ratio)];
        }),
      ),
    };

    out.width = Math.min(newDim.width - 2, Math.max(2, out.width));
    out.height = Math.min(newDim.height - 2, Math.max(2, out.height));
    out.x = Math.min(newDim.width - out.width, Math.max(0, out.x));
    out.y = Math.min(newDim.height - out.height, Math.max(0, out.y));
    return out;
  });
}
async function compose(
  doc: ThumbnailDesign,
  options: ThumbnailExportOptions,
  deps: ThumbnailDependencies,
) {
  const frame = frameFor(doc, deps);
  await verified(frame.path, frame.checksum, deps);
  const bg = doc.layers.find((l) => l.id === "background");
  let background;
  if (bg?.kind === "image") {
    const asset = deps.store.get<{ path: string; checksum: string }>(
      "thumbnail-assets",
      bg.assetId!,
    )?.value;
    if (!asset || asset.checksum !== bg.assetId)
      throw fail("Saved background unavailable");
    background = {
      assetId: bg.assetId!,
      path: await verified(asset.path, asset.checksum, deps),
      checksum: asset.checksum,
    };
  }
  const directory = path.join(
    deps.root,
    "studio",
    "thumbnail-edits",
    randomUUID(),
  );
  return composeThumbnail(
    {
      brief: briefFor(doc, options.aspect),
      frame,
      directory,
      background,
      layers: reflowThumbnail(doc, options.aspect, frame),
      textFree: !options.text,
    },
    new AbortController().signal,
  );
}
async function prepareThumbnailSave(
  doc: ThumbnailStudioDocument,
  expectedRevision: number,
  deps = thumbnailDependencies(),
  options: { restoredFromRevision?: number } = {},
): Promise<{
  current: ThumbnailStudioDocument;
  saved: ThumbnailStudioDocument;
}> {
  revision(expectedRevision);
  const current = getThumbnail(doc.id, undefined, deps);
  if (current.editRevision !== expectedRevision)
    throw Object.assign(
      new RevisionConflict(expectedRevision, current.editRevision),
      { status: 409 },
    );
  if (
    hashManifest(doc.sourceIdentity) !== hashManifest(current.sourceIdentity) ||
    doc.renderChecksum !== current.renderChecksum ||
    doc.layout !== current.layout
  )
    throw fail("Thumbnail source identity is immutable");
  // Restored layers already occupy their historical aspect's coordinate space.
  // Resolve that space from the durable revision, never a client aspect claim.
  let coordinateAspect = current.aspectPreset;
  if (options.restoredFromRevision !== undefined) {
    revision(options.restoredFromRevision);
    const historical = getThumbnail(doc.id, options.restoredFromRevision, deps);
    if (
      hashManifest(historical.sourceIdentity) !==
        hashManifest(current.sourceIdentity) ||
      historical.renderChecksum !== current.renderChecksum ||
      historical.layout !== current.layout
    )
      throw fail("Historical thumbnail source identity does not match");
    coordinateAspect = historical.aspectPreset;
  }
  const layers = z
    .array(layerSchema)
    .min(2)
    .max(12)
    .parse(doc.layers) as ThumbnailLayer[];
  // Never accept client font metrics: fitting measures the actual local font again.
  layers.forEach((layer) => {
    const prior = current.layers.find((old) => old.id === layer.id);
    delete layer.textLayout;
    if (prior?.fontFamily === layer.fontFamily && prior?.textLayout)
      layer.textLayout = structuredClone(prior.textLayout);
  });
  const aspect = optionsSchema.shape.aspect.parse(doc.aspectPreset);
  const next = {
    ...current,
    name: z.string().min(1).max(160).parse(doc.name),
    aspectPreset: aspect,
    layers,
  };
  const frame = frameFor(next, deps);
  if (aspect !== coordinateAspect)
    next.layers = reflowThumbnail(
      { ...next, aspectPreset: coordinateAspect },
      aspect,
      frame,
    );
  const composed = await compose(
    next,
    { aspect, format: "png", text: true },
    deps,
  );
  const saved = {
    ...next,
    layers: composed.layers,
    sourceFrames: [
      {
        assetId: frame.assetId,
        sourceUs: frame.sourceUs,
        checksum: frame.checksum,
      },
    ],
    versions: [...current.versions, ...composed.versions],
    editRevision: expectedRevision + 1,
    reviewState:
      current.reviewState === "stale"
        ? ("stale" as const)
        : ("pending" as const),
  };
  return { current, saved };
}
function commitThumbnailSave(
  {
    current,
    saved,
  }: { current: ThumbnailStudioDocument; saved: ThumbnailStudioDocument },
  expectedRevision: number,
  deps: ThumbnailDependencies,
): ThumbnailStudioDocument {
  return deps.store.transaction(() => {
    const latest = getThumbnail(saved.id, undefined, deps);
    if (latest.editRevision !== expectedRevision)
      throw Object.assign(
        new RevisionConflict(expectedRevision, latest.editRevision),
        { status: 409 },
      );
    deps.store.put(
      "thumbnail-history",
      `${saved.id}:${expectedRevision}`,
      current,
    );
    deps.store.save("thumbnails", saved.id, saved, expectedRevision);
    return saved;
  });
}
export async function saveThumbnail(
  doc: ThumbnailStudioDocument,
  expectedRevision: number,
  deps = thumbnailDependencies(),
  options: { restoredFromRevision?: number } = {},
): Promise<ThumbnailStudioDocument> {
  return commitThumbnailSave(
    await prepareThumbnailSave(doc, expectedRevision, deps, options),
    expectedRevision,
    deps,
  );
}

export async function exportThumbnail(
  id: string,
  editRevision: number,
  options: ThumbnailExportOptions,
  deps = thumbnailDependencies(),
): Promise<ThumbnailExport> {
  revision(editRevision);
  options = optionsSchema.parse(options);
  const doc = getThumbnail(id, editRevision, deps);
  const result = await compose(doc, options, deps),
    version = result.versions.find((v) => v.format === options.format)!;
  return {
    ...version,
    filename: `${id}-r${editRevision}-${options.aspect}${options.text ? "" : "-no-text"}.${options.format}`,
    layers: result.layers,
  };
}
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Small stored ZIPs avoid a streaming dependency and contain only requested immutable outputs. */
export async function exportThumbnailZip(
  requests: { id: string; revision: number; options: ThumbnailExportOptions }[],
  deps = thumbnailDependencies(),
) {
  if (!Array.isArray(requests) || !requests.length || requests.length > 18)
    throw fail("ZIP requires 1–18 requested outputs");
  const local: Buffer[] = [],
    central: Buffer[] = [],
    filenames: string[] = [];
  let offset = 0;
  for (const request of requests) {
    const out = await exportThumbnail(
      request.id,
      request.revision,
      request.options,
      deps,
    );
    if (
      !/^[a-zA-Z0-9_-]+-r\d+-(landscape|portrait|square)(-no-text)?\.(png|jpg)$/.test(
        out.filename,
      ) ||
      filenames.includes(out.filename)
    )
      throw fail("Unsafe or duplicate ZIP filename");
    filenames.push(out.filename);
    const bytes = await readFile(out.path),
      name = Buffer.from(out.filename),
      crc = crc32(bytes),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + bytes.length;
  }
  const index = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(requests.length, 8);
  end.writeUInt16LE(requests.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, index, end]);
  const directory = path.join(deps.root, "studio", "thumbnail-zips");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.zip`);
  await writeFile(file, bytes);
  return { bytes, path: file, filenames };
}
export async function attachThumbnail(
  packageId: string,
  thumbnailId: string,
  editRevision: number,
  deps = thumbnailDependencies(),
): Promise<PublishPackage> {
  const doc = getThumbnail(thumbnailId, editRevision, deps);
  const frame = frameFor(doc, deps);
  const output = await exportThumbnail(
    thumbnailId,
    editRevision,
    { aspect: doc.aspectPreset, format: "jpg", text: true },
    deps,
  );
  return deps.store.transaction(() => {
    const row = deps.store.get<QueueEntry[]>("legacy-state", "queue");
    const entry = row?.value.find((e) => e.publishPackage?.id === packageId);
    if (
      !entry ||
      !entry.publishPackage ||
      !entry.publicationFiles ||
      entry.progress ||
      ["posting", "posted", "needs_action"].includes(entry.status)
    )
      throw fail("Publish package unavailable for attachment", 409);
    const source = doc.sourceIdentity,
      pkg = entry.publishPackage;
    if (
      hashFile(entry.publicationFiles.file) !== source.renderChecksum ||
      pkg.artifact.checksum !== source.renderChecksum ||
      (source.kind === "project"
        ? pkg.artifact.projectId !== source.projectId ||
          pkg.artifact.revision !== source.revision
        : entry.jobId !== source.jobId || entry.n !== source.clipN)
    )
      throw fail("Thumbnail belongs to different source footage/revision");
    const currentSource =
      source.kind === "project"
        ? deps.store.get("projects", source.projectId)
        : deps.store.get("legacy-jobs", source.jobId);
    if (currentSource?.revision !== source.revision)
      throw fail("Thumbnail footage is stale", 409);
    const { packageHash: _hash, ...manifest } = pkg;
    const versionId = randomUUID();
    const attachment = {
      revision: `${thumbnailId}:${editRevision}:${versionId}`,
      checksum: output.checksum,
      designId: thumbnailId,
      versionId,
      sourceIdentity: source,
      sourceFrame: {
        id: frame.id,
        assetId: frame.assetId,
        sourceUs: frame.sourceUs,
        renderUs: frame.renderUs,
        checksum: frame.checksum,
      },
    };
    const attached = buildPublishPackage({
      ...manifest,
      id: `${pkg.id}:thumbnail:${randomUUID()}`,
      thumbnail: attachment,
    });
    deps.store.put("thumbnail-attachments", attached.packageHash, {
      ...attachment,
      editRevision,
      path: output.path,
      packageId: attached.id,
    });
    deps.store.put("publication-history", pkg.packageHash, pkg);
    deps.store.save(
      "legacy-state",
      "queue",
      row!.value.map((e) =>
        e.key !== entry.key
          ? e
          : {
              ...e,
              publishPackage: attached,
              publicationDecision: undefined,
              publicationFiles: {
                ...e.publicationFiles!,
                thumbFile: output.path,
              },
              status: "review",
              slotAt: undefined,
              nextTryAt: undefined,
              progress: undefined,
              updatedAt: Date.now(),
              history: [
                ...e.history,
                {
                  t: Date.now(),
                  msg: "Thumbnail attached; new approval required",
                },
              ],
            },
      ),
      row!.revision,
    );
    return attached;
  });
}
export interface ThumbnailRegeneration {
  id: string;
  designId: string;
  baseRevision: number;
  jobId: string;
  kind: "variation" | "background";
  state: "pending" | "applied" | "failed" | "conflict";
  error?: string;
}
export async function regenerateThumbnail(
  id: string,
  expectedRevision: number,
  kind: ThumbnailRegeneration["kind"],
  requestId: string,
  deps = thumbnailDependencies(),
) {
  const doc = getThumbnail(id, undefined, deps);
  if (doc.editRevision !== expectedRevision)
    throw fail("Thumbnail revision conflict", 409);
  if (
    !["variation", "background"].includes(kind) ||
    !requestId ||
    requestId.length > 120
  )
    throw fail("Invalid explicit regeneration request");
  const identity = hashManifest({ id, expectedRevision, kind, requestId });
  const prior = deps.store.get<ThumbnailRegeneration>(
    "thumbnail-regeneration",
    identity,
  )?.value;
  if (prior) return prior;
  const job = await generateThumbnails(
    {
      source: doc.sourceIdentity,
      aspect: doc.aspectPreset,
      headline: doc.layers.find((l) => l.kind === "text")?.text ?? "",
      selectedFrameIds: [frameFor(doc, deps).id],
      variantCount: 1,
      requestId: `studio-${identity}`,
      allowCloud: true,
    },
    deps,
  );
  const record: ThumbnailRegeneration = {
    id: identity,
    designId: id,
    baseRevision: expectedRevision,
    jobId: job.id,
    kind,
    state: "pending",
  };
  deps.store.save("thumbnail-regeneration", identity, record, 0);
  return record;
}
export async function resolveRegeneration(
  id: string,
  deps = thumbnailDependencies(),
) {
  const row = deps.store.get<ThumbnailRegeneration>(
    "thumbnail-regeneration",
    id,
  );
  if (!row) throw fail("Regeneration not found", 404);
  if (row.value.state !== "pending") return row.value;
  const record = row.value,
    job = deps.queue.get(record.jobId);
  if (!job || !["complete", "needs_action", "cancelled"].includes(job.status))
    return record;
  let next = { ...record };
  if (job.status !== "complete") {
    next = {
      ...next,
      state: "failed",
      error: job.error ?? "Generation failed; selected design preserved",
    };
  } else {
    const current = getThumbnail(record.designId, undefined, deps);
    if (current.editRevision !== record.baseRevision)
      next = {
        ...next,
        state: "conflict",
        error: "Design edited while regenerating; result preserved separately",
      };
    else {
      const generatedIds = job.checkpoint.designs as
        ThumbnailDesign[] | undefined;
      const generated = generatedIds?.[0];
      if (
        !generated ||
        hashManifest(generated.sourceIdentity) !==
          hashManifest(current.sourceIdentity)
      )
        next = { ...next, state: "failed", error: "Generated source mismatch" };
      else {
        try {
          if (generated.imageGeneration.status !== "available")
            throw fail(
              generated.imageGeneration.reason ??
                "Image regeneration unavailable; selected design preserved",
            );
          const edited = structuredClone(current);
          if (record.kind === "variation")
            edited.layers = thumbnailLayers(
              briefFor(current),
              frameFor(current, deps),
            );
          const background = generated.layers.find(
            (l) => l.id === "background",
          )!;
          edited.layers = edited.layers.map((l) =>
            l.id === "background"
              ? {
                  ...background,
                  x: l.x,
                  y: l.y,
                  width: l.width,
                  height: l.height,
                }
              : l,
          );
          const prepared = await prepareThumbnailSave(
            edited,
            record.baseRevision,
            deps,
          );
          return deps.store.transaction(() => {
            const latestRequest = deps.store.get<ThumbnailRegeneration>(
              "thumbnail-regeneration",
              id,
            )!;
            if (latestRequest.value.state !== "pending")
              return latestRequest.value;
            prepared.saved.provenance = generated.provenance;
            prepared.saved.imageGeneration = generated.imageGeneration;
            const saved = commitThumbnailSave(
              prepared,
              record.baseRevision,
              deps,
            );
            deps.store.put(
              "thumbnail-generation-history",
              `${saved.id}:${saved.editRevision}`,
              generated.provenance,
            );
            const applied: ThumbnailRegeneration = {
              ...record,
              state: "applied",
            };
            deps.store.save(
              "thumbnail-regeneration",
              id,
              applied,
              latestRequest.revision,
            );
            return applied;
          });
        } catch (error) {
          next = {
            ...next,
            state: error instanceof RevisionConflict ? "conflict" : "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
  }
  return deps.store.transaction(() => {
    const latest = deps.store.get<ThumbnailRegeneration>(
      "thumbnail-regeneration",
      id,
    )!;
    if (latest.value.state !== "pending") return latest.value;
    deps.store.save("thumbnail-regeneration", id, next, latest.revision);
    return next;
  });
}
