import path from "node:path";
import { deliveryMutationReason } from "../queue";
import { randomUUID, createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type {
  AssetRef,
  ExportPreset,
  JobRecord,
  ProjectDocument,
  RenderArtifact,
} from "../../lib/studio/types";
import { validateProject } from "../../lib/studio/operations";
import {
  compileNormalizedProject,
  renderNormalizedProject,
  validatePreset,
  NORMALIZED_RENDERER_VERSION,
  type NormalizedPlan,
} from "../../src/studio/ffmpeg-adapter";
import {
  studioDependencies,
  checksum,
  mediaUrl,
  type StudioDependencies,
} from "./assets";
import { registerWork } from "../worker/registry";
import { workQueue } from "../worker/api";
import type { WorkStage } from "../worker/runner";

export async function requestProjectRender(
  projectId: string,
  revision: number,
  preset: ExportPreset,
  deps = studioDependencies(),
): Promise<JobRecord> {
  const selected = validatePreset(preset);
  const doc = deps.store.get<ProjectDocument>(
    "project-history",
    `${projectId}:${revision}`,
  )?.value;
  if (!doc || doc.id !== projectId || doc.revision !== revision)
    throw Error("Saved project revision not found");
  validateProject(doc);
  const assets = [
    ...new Set(doc.items.flatMap((i) => (i.assetId ? [i.assetId] : []))),
  ].map((id) => {
    const asset = deps.store.get<AssetRef>("assets", id)?.value;
    if (!asset || asset.status !== "ready")
      throw Error("Wait for all media to finish preparing");
    return asset;
  });
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        doc,
        assets,
        preset: selected,
        renderer: NORMALIZED_RENDERER_VERSION,
      }),
    )
    .digest("hex");
  const baseKey = `studio-render:${identity}`;
  const failed = deps.store
    .list<JobRecord>("work")
    .filter(
      (r) =>
        r.value.workKey.startsWith(baseKey + ":attempt-") &&
        ["cancelled", "needs_action"].includes(r.value.status),
    ).length;
  return (await deps.enqueue({
    kind: "studio-render",
    workKey: `${baseKey}:attempt-${failed}`,
    inputRevision: revision,
    payload: {
      projectId,
      revision,
      preset: selected,
      document: doc,
      assets,
      artifactId: randomUUID(),
    },
  })) as JobRecord;
}
export async function resolveRender(
  projectId: string,
  renderId: string,
  expectedChecksum?: string,
  deps = studioDependencies(),
): Promise<RenderArtifact> {
  const artifact = deps.store.get<RenderArtifact>("renders", renderId)?.value;
  if (
    !artifact ||
    artifact.id !== renderId ||
    artifact.projectId !== projectId ||
    (expectedChecksum && artifact.checksum !== expectedChecksum)
  )
    throw Error("Render identity not found");
  const root = await realpath(deps.root),
    file = await realpath(artifact.path);
  if (
    !file.startsWith(root + path.sep) ||
    (await checksum(file)) !== artifact.checksum
  )
    throw Error("Render bytes changed or missing");
  return artifact;
}
export function renderStatus(projectId: string, deps = studioDependencies()) {
  const current = deps.store.get<ProjectDocument>("projects", projectId)?.value;
  if (!current) throw Error("Project not found");
  return {
    revision: current.revision,
    artifacts: deps.store
      .list<RenderArtifact>("renders")
      .map((r) => r.value)
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map((r) => ({
        ...r,
        path: undefined,
        url: mediaUrl(r.path, deps.root),
        current: r.revision === current.revision,
      })),
    work: deps.store
      .list<JobRecord>("work")
      .map((r) => r.value)
      .filter(
        (r) => r.kind === "studio-render" && r.payload.projectId === projectId,
      )
      .map((r) => ({
        id: r.id,
        status: r.status,
        stage: r.stage,
        error: r.error,
        inputRevision: r.inputRevision,
        createdAt: r.createdAt,
      })),
  };
}
export function studioRenderStages(
  deps: StudioDependencies = studioDependencies(),
): WorkStage[] {
  return [
    {
      name: "compile",
      timeoutMs: 120000,
      run: async (ctx) => {
        const doc = ctx.lease.payload.document as ProjectDocument,
          assets = ctx.lease.payload.assets as AssetRef[];
        if (
          !doc ||
          doc.id !== ctx.lease.payload.projectId ||
          doc.revision !== ctx.lease.inputRevision
        )
          throw Error("Invalid render snapshot");
        const stored = deps.store.get<ProjectDocument>(
          "project-history",
          `${doc.id}:${doc.revision}`,
        )?.value;
        if (JSON.stringify(stored) !== JSON.stringify(doc))
          throw Error("Project snapshot changed");
        const root = await realpath(deps.root);
        for (const a of assets)
          if (!(await realpath(a.location)).startsWith(root + path.sep))
            throw Error("Render asset outside media folder");
        return {
          data: {
            renderPlan: await compileNormalizedProject(
              doc,
              assets,
              ctx.lease.payload.preset as ExportPreset,
            ),
          },
        };
      },
    },
    {
      name: "render",
      expensive: true,
      timeoutMs: 30 * 60000,
      run: async (ctx) => {
        const plan = ctx.data.renderPlan as NormalizedPlan,
          id = String(ctx.lease.payload.artifactId);
        if (!/^[\w-]+$/.test(id)) throw Error("Invalid artifact ID");
        const artifact = await renderNormalizedProject(
          plan,
          ctx.signal,
          path.join(ctx.workspace, "compose"),
        );
        const destination = path.join(
          deps.root,
          "studio",
          "renders",
          id,
          "render.mp4",
        );
        return {
          data: { artifact: { ...artifact, id, path: destination } },
          artifacts: [{ from: artifact.path, to: destination }],
        };
      },
    },
    {
      name: "register",
      timeoutMs: 120000,
      run: async (ctx) => {
        const artifact = ctx.data.artifact as RenderArtifact;
        if (!artifact || (await checksum(artifact.path)) !== artifact.checksum)
          throw Error("Completed render checksum missing or changed");
        ctx.fenced(() => {
          const prior = deps.store.get<RenderArtifact>(
            "renders",
            artifact.id,
          )?.value;
          if (prior && prior.checksum !== artifact.checksum)
            throw Error("Immutable render identity conflict");
          if (!prior) deps.store.save("renders", artifact.id, artifact, 0);
        });
      },
    },
  ];
}
export function registerRenderWorkers() {
  registerWork("studio-render", () => studioRenderStages());
}
export async function cancelProjectRender(projectId: string, workId: string) {
  const q = workQueue(),
    work = q.get(workId);
  if (work?.kind !== "studio-render" || work.payload.projectId !== projectId)
    throw Error("Render work not found");
  await q.cancel(workId);
}

/** A local review draft keeps the exact Studio identity; it never schedules or uploads. */
export async function prepareRenderReview(
  projectId: string,
  renderId: string,
  expectedChecksum: string,
  platform: import("../../lib/types").Platform,
  text: import("../../lib/types").PostText,
) {
  const deps = studioDependencies(),
    artifact = await resolveRender(projectId, renderId, expectedChecksum, deps);
  const current = deps.store.get<ProjectDocument>("projects", projectId)?.value;
  if (current?.revision !== artifact.revision)
    throw Error("Export the current project revision before preparing review");
  const { queue } = await import("../queue");
  const {
    connectedAccountId,
    buildPublishPackage,
    hashManifest,
    mediaOptions,
    deliveryOptions,
    PUBLICATION_POLICY_VERSION,
  } = await import("../publication-policy");
  const now = Date.now();
  const entry: import("../../lib/types").QueueEntry = {
    key: `studio:${artifact.id}:${platform}`,
    source: {
      kind: "studio",
      projectId,
      revision: artifact.revision,
      renderId,
      renderChecksum: artifact.checksum,
    },
    platform,
    status: "review",
    clipTitle: current.name ?? "Studio project",
    videoTitle: current.name ?? "Studio project",
    videoUrl: mediaUrl(artifact.path, deps.root),
    link: `/studio/${projectId}`,
    publicationFiles: { file: artifact.path },
    text,
    attempts: 0,
    history: [
      {
        t: now,
        msg: `Studio revision ${artifact.revision}, waiting for review`,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const accountId = connectedAccountId(platform);
  if (accountId)
    entry.publishPackage = buildPublishPackage({
      id: randomUUID(),
      artifact: {
        id: artifact.id,
        projectId,
        revision: artifact.revision,
        checksum: artifact.checksum,
      },
      text,
      textHash: hashManifest(text),
      platform,
      accountId,
      policyVersion: PUBLICATION_POLICY_VERSION,
      mediaOptionsHash: mediaOptions(entry),
      deliveryOptions: deliveryOptions(platform),
    });
  queue().mutate((all) => {
    const old = all.find((e) => e.key === entry.key);
    const reason = old && deliveryMutationReason(old, deps.store);
    if (reason) throw Error(reason);
    if (old && ["posting", "posted"].includes(old.status))
      throw Error("This render is already posting or posted");
    return [...all.filter((e) => e.key !== entry.key), entry];
  });
  return entry;
}
