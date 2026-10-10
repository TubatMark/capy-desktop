import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import type { ProjectDocument, AssetRef } from "../../lib/studio/types";
import type { JobState } from "../../lib/types";
import { mapSources, validateProject } from "../../lib/studio/operations";
import { projectRepository } from "../repositories/projects";
import { RevisionConflict } from "../db";
import {
  importAsset,
  mediaUrl,
  studioDependencies,
  type StudioDependencies,
} from "./assets";
export interface ProjectSource {
  assetId?: string;
  jobId?: string;
  clipN?: number;
  startUs?: number;
  endUs?: number;
}
export interface ProjectSeed {
  name?: string;
  sources?: ProjectSource[];
  duplicateId?: string;
}
const range = (start: number, end: number) => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  )
    throw Error("Invalid source range");
};
async function sourceAsset(
  source: ProjectSource,
  deps: StudioDependencies,
): Promise<{ asset: AssetRef; start: number; end: number }> {
  if (source.assetId) {
    const asset = deps.store.get<AssetRef>("assets", source.assetId)?.value;
    if (!asset) throw Error("Asset not found");
    const start = source.startUs ?? 0;
    const end = source.endUs ?? asset.durationUs;
    if (end === undefined)
      throw Error("Wait for asset probe before adding to the timeline");
    range(start, end);
    if (asset.durationUs !== undefined && end > asset.durationUs)
      throw Error("Source range exceeds media duration");
    return { asset, start, end };
  }
  const job = source.jobId
    ? deps.store.get<JobState>("legacy-jobs", source.jobId)?.value
    : undefined;
  if (!job) throw Error("Source job not found");
  const clip = job.clips.find((c) => c.n === source.clipN);
  const start =
    source.startUs ?? (clip ? Math.round(clip.start * 1000000) : NaN);
  const end = source.endUs ?? (clip ? Math.round(clip.end * 1000000) : NaN);
  range(start, end);
  if (
    !job.videoId ||
    !/^[-_a-zA-Z0-9]{11}$/.test(job.videoId) ||
    !job.duration ||
    end > Math.round(job.duration * 1000000)
  )
    throw Error("Source range exceeds video duration");
  const seg = clip?.segment;
  const cached =
    seg?.status === "done" &&
    start >= Math.round(seg.start * 1000000) &&
    end <= Math.round(seg.end * 1000000);
  const id = randomUUID();
  let asset: AssetRef;
  if (cached) {
    if (!seg.url.startsWith("/api/media/"))
      throw Error("Invalid cached media URL");
    const relative = decodeURIComponent(seg.url.slice("/api/media/".length));
    const file = path.resolve(deps.root, relative);
    const root = await realpath(deps.root);
    const resolved = await realpath(file).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    // A stale cached segment must request footage rather than constrain or corrupt the new edit.
    if (!resolved)
      return sourceAsset(
        { ...source, clipN: undefined, startUs: start, endUs: end },
        deps,
      );
    if (!resolved.startsWith(root + path.sep))
      throw Error("Cached media outside output folder");
    await stat(resolved);
    asset = await importAsset(
      { path: resolved, kind: "video", name: clip?.title ?? job.title },
      deps,
    );
    const row = deps.store.get<AssetRef>("assets", asset.id)!;
    asset = {
      ...row.value,
      durationUs: Math.round((seg.end - seg.start) * 1000000),
      original: {
        jobId: job.id,
        videoId: job.videoId,
        sourceOffsetUs: Math.round(seg.start * 1000000),
      },
    };
    deps.store.save("assets", asset.id, asset, row.revision);
    return {
      asset,
      start: start - Math.round(seg.start * 1000000),
      end: end - Math.round(seg.start * 1000000),
    };
  }
  const destination = path.join(
    deps.root,
    "studio",
    "assets",
    id,
    "source.mp4",
  );
  asset = {
    id,
    kind: "video",
    checksum: "",
    location: destination,
    mediaUrl: mediaUrl(destination, deps.root),
    durationUs: end - start,
    original: { jobId: job.id, videoId: job.videoId, sourceOffsetUs: start },
    request: {
      jobId: job.id,
      videoId: job.videoId,
      startUs: start,
      endUs: end,
    },
    status: "waiting",
    name: clip?.title ?? job.title,
  };
  deps.store.save("assets", id, asset, 0);
  const work = await deps
    .enqueue({
      kind: "source-range",
      workKey: `source:${job.videoId}:${start}:${end}:${id}`,
      inputRevision: 1,
      payload: {
        assetId: id,
        jobId: job.id,
        videoId: job.videoId,
        startUs: start,
        endUs: end,
        destination,
      },
    })
    .catch((error) => {
      deps.store.save(
        "assets",
        id,
        {
          ...asset,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
        1,
      );
      throw error;
    });
  asset.workId = work.id;
  deps.store.save("assets", id, asset, 1);
  return { asset, start: 0, end: end - start };
}
/** Existing transcripts remain read-only; timestamps become relative to imported asset bytes. */
async function seedSourceWords(
  doc: ProjectDocument,
  asset: AssetRef,
  deps: StudioDependencies,
) {
  if (
    !asset.original?.jobId ||
    doc.sourceWords?.some((source) => source.assetId === asset.id)
  )
    return;
  const job = deps.store.get<JobState>(
    "legacy-jobs",
    asset.original.jobId,
  )?.value;
  if (!job?.dir) return;
  try {
    const root = await realpath(deps.root);
    const file = await realpath(path.resolve(root, job.dir, "words.json"));
    if (!file.startsWith(root + path.sep)) return;
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(raw)) return;
    const offset = asset.original.sourceOffsetUs ?? 0;
    const words = raw.flatMap((word, index) => {
      if (
        !word ||
        typeof word.text !== "string" ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end)
      )
        return [];
      const startUs = Math.round(word.start * 1000000) - offset,
        endUs = Math.round(word.end * 1000000) - offset;
      if (
        endUs <= 0 ||
        endUs <= startUs ||
        (asset.durationUs !== undefined && startUs >= asset.durationUs)
      )
        return [];
      return [
        {
          id: `word:${index}`,
          text: word.text,
          startUs: Math.max(0, startUs),
          endUs,
        },
      ];
    });
    if (words.length)
      doc.sourceWords = [
        ...(doc.sourceWords ?? []),
        { assetId: asset.id, words },
      ];
  } catch {
    // Absent local transcripts are shown in Studio; this path never starts a provider.
  }
}
export async function createProject(
  input: ProjectSeed,
  deps = studioDependencies(),
): Promise<ProjectDocument> {
  if (
    !input ||
    typeof input !== "object" ||
    (input.name !== undefined &&
      (typeof input.name !== "string" || input.name.length > 200)) ||
    (input.sources !== undefined &&
      (!Array.isArray(input.sources) || input.sources.length > 100))
  )
    throw Error("Invalid project seed");
  const duplicate = input.duplicateId
    ? projectRepository(deps.store).get(input.duplicateId)
    : undefined;
  if (input.duplicateId && !duplicate) throw Error("Project not found");
  const doc: ProjectDocument = duplicate
    ? {
        ...structuredClone(duplicate),
        id: randomUUID(),
        revision: 0,
        name: input.name ?? `${duplicate.name ?? "Project"} copy`,
      }
    : {
        schemaVersion: 1,
        id: randomUUID(),
        revision: 0,
        name: input.name ?? "Untitled project",
        canvas: { width: 1080, height: 1920 },
        fps: { numerator: 30, denominator: 1 },
        tracks: [
          { id: "video", kind: "video" },
          { id: "audio", kind: "audio" },
        ],
        items: [],
        sourceMappings: [],
        captionCues: [],
        thumbnailIds: [],
      };
  let cursor = 0;
  for (const source of input.sources ?? []) {
    if (!source || typeof source !== "object") throw Error("Invalid source");
    const { asset, start, end } = await sourceAsset(source, deps);
    await seedSourceWords(doc, asset, deps);
    if (asset.kind === "font") throw Error("Font cannot be a footage source");
    const durationFrames = Math.round(
      ((end - start) * doc.fps.numerator) / (1000000 * doc.fps.denominator),
    );
    if (durationFrames < 1)
      throw Error("Source span is shorter than one frame");
    doc.items.push({
      id: randomUUID(),
      trackId: asset.kind === "audio" ? "audio" : "video",
      assetId: asset.id,
      startFrame: cursor,
      durationFrames,
      sourceInUs: start,
      sourceOutUs: end,
      speed: 1,
    });
    cursor += durationFrames;
  }
  doc.createdAt = Date.now();
  doc.updatedAt = doc.createdAt;
  mapSources(doc);
  return saveProject(doc, 0, deps);
}
export async function saveProject(
  doc: ProjectDocument,
  expectedRevision: number,
  deps = studioDependencies(),
) {
  validateProject(doc);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    doc.revision !== expectedRevision
  )
    throw Error("Invalid expected revision");
  for (const i of doc.items)
    if (i.assetId) {
      const asset = deps.store.get<AssetRef>("assets", i.assetId)?.value;
      if (!asset) throw Error("Unknown asset");
      if (
        asset.durationUs !== undefined &&
        Math.max(i.sourceOutUs!, i.sourceAvailableOutUs ?? 0) >
          asset.durationUs + 1
      )
        throw Error("Item exceeds asset duration");
    }
  try {
    return await deps.store.transaction(() => {
      const current = deps.store.get<ProjectDocument>("projects", doc.id);
      if (
        current?.revision !== expectedRevision &&
        !(expectedRevision === 0 && !current)
      )
        throw new RevisionConflict(expectedRevision, current?.revision);
      const next = {
        ...doc,
        revision: expectedRevision + 1,
        updatedAt: Date.now(),
      };
      deps.store.save("projects", doc.id, next, expectedRevision);
      deps.store.put("project-history", `${doc.id}:${next.revision}`, next);
      return next;
    });
  } catch (e) {
    if (e instanceof RevisionConflict) throw Object.assign(e, { status: 409 });
    throw e;
  }
}
export function projectHistory(id: string, deps = studioDependencies()) {
  return deps.store
    .list<ProjectDocument>("project-history")
    .map((r) => r.value)
    .filter((d) => d.id === id)
    .sort((a, b) => b.revision - a.revision);
}
export function getProject(id: string, deps = studioDependencies()) {
  const document = projectRepository(deps.store).get(id);
  if (document) validateProject(document);
  return document;
}
export function listProjects(deps = studioDependencies()) {
  return deps.store
    .list<ProjectDocument>("projects")
    .map((r) => {
      const document = { ...r.value, revision: r.revision };
      validateProject(document);
      return document;
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
