import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AssetRef,
  JobRecord,
  ProjectDocument,
  RenderArtifact,
} from "../lib/studio/types";
import type { JobState } from "../lib/types";
import { DEFAULT_AI_ROUTING, type AiRoutingSettings } from "../lib/ai-policy";
import type {
  FrameCandidate,
  ThumbnailDesign,
  ThumbnailLayout,
  ThumbnailRequest,
  ThumbnailSource,
  ThumbnailSourceRef,
} from "../lib/thumbnails";
import type { Store } from "./db";
import { runtimeStore } from "./db/runtime";
import { OUTPUT_ROOT } from "./paths";
import { loadSettings } from "./settings";
import { checksum } from "./studio/assets";
import { validateProject } from "../lib/studio/operations";
import { WorkQueue, LeaseLostError } from "./worker/leases";
import { registerWork } from "./worker/registry";
import type { StageContext, WorkStage } from "./worker/runner";
import { reserveAiBudget, settleAiBudget, recordAiRun } from "./ai-usage";
import { aiCacheIdentity } from "./ai-router";
import { extractFrameCandidates } from "../src/thumbnails/frames";
import { buildThumbnailBrief } from "../src/thumbnails/brief";
import { creatorPolicy } from "./automation-policy";
import { pickThumbnail, type VisionAsk } from "./thumbnail-pick";
import { composeThumbnail } from "../src/thumbnails/compose";
import {
  configuredImageProvider,
  type ImageProvider,
  type ImageResult,
} from "../src/thumbnails/provider";
export interface ThumbnailDependencies {
  store: Store;
  root: string;
  queue: WorkQueue;
  settings: AiRoutingSettings;
  provider?: ImageProvider;
  /** Trusted creator policy, never supplied by a request. Without it automatic generation is refused. */
  allowAutomatic?: (source: ThumbnailSourceRef) => boolean;
  /** Vision question for the automatic frame/headline pick; defaults to Claude through the AI router. */
  ask?: VisionAsk;
}
/** Only clips the creator automation made, for a channel whose saved (or default) options say "automatic". */
export function automaticThumbnailsAllowed(
  source: ThumbnailSourceRef,
  store: Store = runtimeStore(),
) {
  if (source.kind !== "legacy") return false;
  const link = store.get<{ channelId: string }>(
    "automation-jobs",
    source.jobId,
  )?.value;
  return (
    !!link && creatorPolicy(link.channelId).thumbnailGeneration === "automatic"
  );
}
export function thumbnailDependencies(): ThumbnailDependencies {
  const store = runtimeStore();
  return {
    store,
    root: OUTPUT_ROOT,
    queue: new WorkQueue(store),
    settings: loadSettings().aiRouting ?? DEFAULT_AI_ROUTING,
    provider: configuredImageProvider(),
    allowAutomatic: (source) => automaticThumbnailsAllowed(source, store),
  };
}
const terminal = (message: string) =>
  Object.assign(Error(message), { retryable: false });
function validateIdentity(source: ThumbnailSourceRef) {
  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    !["legacy", "project"].includes(source.kind) ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0 ||
    !/^[a-f0-9]{64}$/.test(source.renderChecksum)
  )
    throw terminal("Invalid exact source revision/checksum identity");
  const fields =
    source.kind === "legacy"
      ? ["kind", "jobId", "clipN", "revision", "renderChecksum"]
      : ["kind", "projectId", "revision", "renderId", "renderChecksum"];
  if (Object.keys(source).some((key) => !fields.includes(key)))
    throw terminal(
      "Source requests accept stable IDs only, never paths or document snapshots",
    );
  if (
    source.kind === "legacy" &&
    (typeof source.jobId !== "string" ||
      !source.jobId ||
      !Number.isSafeInteger(source.clipN) ||
      source.clipN < 1)
  )
    throw terminal("Invalid clip identity");
  if (
    source.kind === "project" &&
    (typeof source.projectId !== "string" ||
      !source.projectId ||
      typeof source.renderId !== "string" ||
      !source.renderId)
  )
    throw terminal("Invalid project/render identity");
}
async function trustedPath(file: string, root: string, digest: string) {
  const base = await realpath(root),
    actual = await realpath(file);
  if (!actual.startsWith(base + path.sep))
    throw terminal("Thumbnail media resolves outside output folder");
  if ((await checksum(actual)) !== digest)
    throw terminal("Thumbnail source checksum changed");
  return actual;
}
/** Resolve immutable render identity and original source mapping using server-owned records only. */
export async function resolveThumbnailSource(
  ref: ThumbnailSourceRef,
  deps = thumbnailDependencies(),
): Promise<ThumbnailSource> {
  validateIdentity(ref);
  if (ref.kind === "legacy") {
    const row = deps.store.get<JobState>("legacy-jobs", ref.jobId),
      clip = row?.value.clips.find((c) => c.n === ref.clipN);
    if (
      !row ||
      row.revision !== ref.revision ||
      !clip ||
      clip.render.status !== "done" ||
      !clip.render.file
    )
      throw terminal("Source clip revision is unavailable or stale");
    return {
      kind: "legacy",
      clipId: `${ref.jobId}:${ref.clipN}`,
      revision: ref.revision,
      assetId: `${ref.jobId}:source`,
      path: await trustedPath(clip.render.file, deps.root, ref.renderChecksum),
      checksum: ref.renderChecksum,
      sourceOffsetUs: Math.round(clip.start * 1_000_000),
    };
  }
  const current = deps.store.get<ProjectDocument>("projects", ref.projectId);
  const project =
    deps.store.get<ProjectDocument>(
      "project-history",
      `${ref.projectId}:${ref.revision}`,
    )?.value ??
    (current?.revision === ref.revision ? current.value : undefined);
  const render = deps.store.get<RenderArtifact>("renders", ref.renderId)?.value;
  if (
    !project ||
    project.id !== ref.projectId ||
    project.revision !== ref.revision ||
    !render ||
    render.id !== ref.renderId ||
    render.projectId !== ref.projectId ||
    render.revision !== ref.revision ||
    render.checksum !== ref.renderChecksum
  )
    throw terminal("Exact project revision/render identity is unavailable");
  validateProject(project);
  const assets = [];
  for (const id of new Set(
    project.items
      .filter(
        (i) =>
          i.assetId &&
          project.tracks.some((t) => t.id === i.trackId && t.kind === "video"),
      )
      .map((i) => i.assetId!),
  )) {
    const asset = deps.store.get<AssetRef>("assets", id)?.value;
    if (
      !asset ||
      asset.status !== "ready" ||
      !["video", "image"].includes(asset.kind)
    )
      throw terminal("Original visual asset is unavailable");
    assets.push({
      id,
      kind: asset.kind as "video" | "image",
      path: await trustedPath(asset.location, deps.root, asset.checksum),
      checksum: asset.checksum,
      sourceOffsetUs: asset.original?.sourceOffsetUs,
    });
  }
  return {
    kind: "project",
    project: structuredClone(project),
    render: {
      ...render,
      path: await trustedPath(render.path, deps.root, render.checksum),
    },
    assets,
  };
}
function identityHash(source: ThumbnailSourceRef) {
  return aiCacheIdentity(source);
}
function validateRequest(input: ThumbnailRequest, deps: ThumbnailDependencies) {
  validateIdentity(input.source);
  if (
    !["landscape", "portrait", "square"].includes(input.aspect) ||
    typeof input.headline !== "string" ||
    !input.headline.trim() ||
    input.headline.length > 120 ||
    /[\x00-\x1f]/.test(input.headline)
  )
    throw terminal("Invalid thumbnail aspect/headline");
  for (const flag of [input.allowCloud, input.allowLocal])
    if (flag !== undefined && typeof flag !== "boolean")
      throw terminal("Invalid thumbnail privacy setting");
  if (
    input.requestId !== undefined &&
    (typeof input.requestId !== "string" ||
      !input.requestId ||
      input.requestId.length > 100)
  )
    throw terminal("Invalid generation request ID");
  if (
    input.frameTimeUs !== undefined &&
    (!Number.isSafeInteger(input.frameTimeUs) ||
      input.frameTimeUs < 0 ||
      input.selectedFrameIds?.length)
  )
    throw terminal("Invalid manual frame selection");
  if (
    input.frameKind !== undefined &&
    !["clean", "finished"].includes(input.frameKind)
  )
    throw terminal("Invalid source frame kind");
  if (input.style !== undefined && !["bold", "clean"].includes(input.style))
    throw terminal("Invalid thumbnail style");
  if (
    input.action !== undefined &&
    !["frames", "generate"].includes(input.action)
  )
    throw terminal("Invalid thumbnail action");
  if (input.mode !== undefined && !["manual", "automatic"].includes(input.mode))
    throw terminal("Invalid thumbnail generation mode");
  if (input.mode === "automatic" && !deps.allowAutomatic?.(input.source))
    throw terminal(
      "Automatic thumbnail generation requires an explicit creator policy",
    );
  if (
    input.variantCount !== undefined &&
    (!Number.isInteger(input.variantCount) ||
      input.variantCount < 1 ||
      input.variantCount > 3)
  )
    throw terminal("Thumbnail variant count must be 1–3");
  if (input.clipContext !== undefined) {
    const c = input.clipContext as Record<string, unknown>;
    if (
      !c ||
      typeof c !== "object" ||
      Array.isArray(c) ||
      Object.keys(c).some(
        (k) => !["title", "hook", "transcript"].includes(k),
      ) ||
      Object.entries(c).some(
        ([k, v]) =>
          v !== undefined &&
          (typeof v !== "string" ||
            v.length > (k === "transcript" ? 4000 : 300)),
      )
    )
      throw terminal("Invalid clip context");
  }
  for (const limit of [input.maxDayUsd, input.maxJobUsd])
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 0))
      throw terminal("Invalid thumbnail budget override");
  if (
    input.selectedFrameIds !== undefined &&
    (!Array.isArray(input.selectedFrameIds) ||
      !input.selectedFrameIds.length ||
      input.selectedFrameIds.length > 3 ||
      new Set(input.selectedFrameIds).size !== input.selectedFrameIds.length ||
      input.selectedFrameIds.some((id) => typeof id !== "string"))
  )
    throw terminal("Select one to three distinct frame IDs");
}
interface StoredFrame extends FrameCandidate {
  sourceIdentity: ThumbnailSourceRef;
}
function selectedFrames(input: ThumbnailRequest, deps: ThumbnailDependencies) {
  return (input.selectedFrameIds ?? []).map((id) => {
    const frame = deps.store.get<StoredFrame>("thumbnail-frames", id)?.value;
    if (
      !frame ||
      identityHash(frame.sourceIdentity) !== identityHash(input.source)
    )
      throw terminal(
        "Selected frame does not belong to this exact source revision",
      );
    return frame;
  });
}
export async function generateThumbnails(
  input: ThumbnailRequest,
  deps = thumbnailDependencies(),
): Promise<JobRecord> {
  validateRequest(input, deps);
  await resolveThumbnailSource(input.source, deps);
  for (const frame of selectedFrames(input, deps))
    await trustedPath(frame.path, deps.root, frame.checksum);
  const request = structuredClone(input);
  return deps.queue.enqueue({
    kind: "thumbnail",
    workKey: `thumbnail:${aiCacheIdentity(request)}`,
    inputRevision: input.source.revision,
    payload: {
      request,
      jobId:
        input.source.kind === "legacy"
          ? input.source.jobId
          : input.source.projectId,
    },
  });
}
export function listThumbnailFrames(
  source: ThumbnailSourceRef,
  deps = thumbnailDependencies(),
) {
  return deps.store
    .list<StoredFrame>("thumbnail-frames")
    .map((r) => r.value)
    .filter(
      (frame) => identityHash(frame.sourceIdentity) === identityHash(source),
    )
    .sort((a, b) => b.quality.score - a.quality.score);
}
function sourceStale(source: ThumbnailSourceRef, deps: ThumbnailDependencies) {
  if (source.kind === "project")
    return (
      deps.store.get<ProjectDocument>("projects", source.projectId)
        ?.revision !== source.revision
    );
  const row = deps.store.get<JobState>("legacy-jobs", source.jobId);
  return (
    row?.revision !== source.revision ||
    row.value.clips.find((c) => c.n === source.clipN)?.render.status !== "done"
  );
}
/** Staleness is computed against current media identity; every old version remains downloadable. */
export function listThumbnails(
  source?: ThumbnailSourceRef,
  deps = thumbnailDependencies(),
): ThumbnailDesign[] {
  return deps.store
    .list<ThumbnailDesign>("thumbnails")
    .map((row) => {
      const design = row.value;
      if (
        sourceStale(design.sourceIdentity, deps) &&
        design.reviewState !== "stale"
      ) {
        const stale = { ...design, reviewState: "stale" as const };
        deps.store.save("thumbnails", row.id, stale, row.revision);
        return stale;
      }
      return design;
    })
    .filter(
      (d) => !source || identityHash(d.sourceIdentity) === identityHash(source),
    );
}
/** The AI pick and auto-attach serve automatic requests; manual Studio requests keep the user's frame and headline. */
const aiPicks = (input: ThumbnailRequest) =>
  input.mode === "automatic" &&
  input.action !== "frames" &&
  !input.selectedFrameIds?.length &&
  input.frameTimeUs === undefined;
function requestFor(ctx: StageContext, deps: ThumbnailDependencies) {
  const input = ctx.lease.payload.request as ThumbnailRequest;
  validateRequest(input, deps);
  return input;
}
function providerFor(
  input: ThumbnailRequest,
  deps: ThumbnailDependencies,
): { provider?: ImageProvider; reason?: string } {
  const provider = deps.provider;
  if (!provider)
    return {
      reason:
        "No reference-image-capable provider configured. Local editable templates are available; text CLI adapters cannot generate images.",
    };
  if (
    !provider.local &&
    (!deps.settings.allowCloud || input.allowCloud === false)
  )
    return {
      reason:
        "Cloud image uploads are disabled by privacy settings; local editable templates are available.",
    };
  if (provider.local && input.allowLocal === false)
    throw terminal("Local generation is disabled by privacy settings");
  if (
    !provider.capabilities.referenceImages ||
    !provider.capabilities.imageGeneration ||
    !provider.capabilities.preserveSubject
  )
    throw terminal(
      "Image adapter lacks verified reference-image generation capability",
    );
  if (
    deps.settings.usageLimitMode === "provider" &&
    (!provider.capabilities.providerQuotaBound ||
      provider.bounds.basis !== "verified")
  )
    throw terminal(
      "Image adapter cannot enforce strict provider token/request/cost bounds; application mode uses labelled estimates",
    );
  if (
    !Number.isFinite(provider.bounds.costUsd) ||
    provider.bounds.costUsd < 0 ||
    (!provider.local && provider.bounds.costUsd === 0) ||
    ![provider.bounds.requests, provider.bounds.tokens].every(
      (n) => Number.isSafeInteger(n) && n >= 1,
    )
  )
    throw terminal("Invalid image provider budget bounds");
  return { provider };
}
async function imageResults(
  input: ThumbnailRequest,
  frames: FrameCandidate[],
  ctx: StageContext,
  deps: ThumbnailDependencies,
  layouts?: ThumbnailLayout[],
): Promise<{ results: (ImageResult | undefined)[]; reason?: string }> {
  const { provider, reason } = providerFor(input, deps),
    count = input.variantCount ?? 3;
  if (!provider)
    return { results: Array.from({ length: count }, () => undefined), reason };
  const key = `${ctx.lease.id}:images`,
    prior = deps.store.get<{ results: ImageResult[] }>(
      "thumbnail-image-result",
      key,
    )?.value;
  if (prior) return { results: prior.results };
  if (deps.store.get("ai-reservation", key))
    throw terminal(
      "Interrupted image generation has an unreconciled reservation; existing versions are preserved. Create a new explicit request to retry.",
    );
  const retries = Math.min(1, deps.settings.retryLimit),
    allowance = count + retries;
  ctx.assert();
  const reservation = await reserveAiBudget(
    {
      key,
      jobId: String(ctx.lease.payload.jobId),
      task: "thumbnail-generation",
      ceilingUsd: provider.bounds.costUsd * allowance,
      requests: provider.bounds.requests * allowance,
      tokens: provider.bounds.tokens * allowance,
      maxJobUsd: Math.min(deps.settings.maxJobUsd, input.maxJobUsd ?? Infinity),
      maxDayUsd: Math.min(deps.settings.maxDayUsd, input.maxDayUsd ?? Infinity),
      maxDayRequests: deps.settings.maxDayRequests,
      maxDayTokens: deps.settings.maxDayTokens,
    },
    deps.store,
  );
  let retryLeft = retries,
    totalCost = 0,
    unknown = false,
    tokens = 0,
    usageKnown = true,
    calls = 0;
  const results: ImageResult[] = [];
  try {
    for (let variant = 0; variant < count; variant++)
      for (;;) {
        ctx.assert();
        ctx.signal.throwIfAborted();
        const start = Date.now();
        let result: ImageResult | undefined;
        calls++;
        const brief = buildThumbnailBrief({
          headline: input.headline,
          aspect: input.aspect,
          style: input.style,
          variant,
          layout: layouts?.[variant],
          frames,
        });
        try {
          result = await provider.generate(
            {
              frames,
              brief,
              outputDirectory: path.join(
                ctx.workspace,
                `provider-${variant}-${calls}`,
              ),
            },
            ctx.signal,
          );
          if (
            result.cost.basis === "unknown" ||
            result.cost.value === undefined
          )
            unknown = true;
          else if (
            !Number.isFinite(result.cost.value) ||
            result.cost.value < 0
          ) {
            unknown = true;
            throw terminal("Invalid image cost receipt");
          } else totalCost += result.cost.value;
          if (result.usage?.tokens === undefined) usageKnown = false;
          else if (
            !Number.isSafeInteger(result.usage.tokens) ||
            result.usage.tokens < 0
          ) {
            usageKnown = false;
            throw terminal("Invalid image usage receipt");
          } else tokens += result.usage.tokens;
          ctx.assert();
          ctx.signal.throwIfAborted();
          if (
            deps.settings.usageLimitMode === "provider" &&
            (result.cost.basis === "unknown" ||
              result.cost.value === undefined ||
              result.cost.value > provider.bounds.costUsd ||
              result.usage?.tokens === undefined ||
              result.usage.tokens > provider.bounds.tokens ||
              result.usage.requests > provider.bounds.requests)
          )
            throw terminal(
              "Provider receipt exceeded its verified bounds; no further calls are admitted",
            );
          if (
            result.assets.length !== 1 ||
            result.assets.some(
              (a) =>
                a.kind !== "background" || !/^[a-f0-9]{64}$/.test(a.checksum),
            )
          )
            throw terminal(
              "Image output must be one verified background asset",
            );
          if (
            result.provider !== provider.id ||
            result.model !== provider.model
          )
            throw terminal(
              "Image provider identity differs from its configured model",
            );
          for (const asset of result.assets) {
            const actual = await realpath(asset.path),
              workspace = await realpath(ctx.workspace);
            if (
              !actual.startsWith(workspace + path.sep) ||
              (await checksum(actual)) !== asset.checksum
            )
              throw terminal(
                "Provider output is outside the worker workspace or changed",
              );
          }
          await recordAiRun(
            {
              runId: randomUUID(),
              task: "thumbnail-generation",
              inputVersion: identityHash(input.source),
              provider: provider.id,
              model: provider.model,
              actualModel: result.model,
              routingReason:
                "Explicit reference-image provider; background only, source subject composed locally",
              attempt: calls,
              latencyMs: Date.now() - start,
              cost: result.cost,
              outcome: "success",
              cacheIdentity: key,
              reservationId: key,
              at: Date.now(),
              ...(result.usage?.inputTokens !== undefined &&
              result.usage.outputTokens !== undefined
                ? {
                    usage: {
                      inputTokens: result.usage.inputTokens,
                      outputTokens: result.usage.outputTokens,
                    },
                  }
                : {}),
            },
            deps.store,
          );
          results.push(result);
          break;
        } catch (error) {
          if (!result) {
            unknown = true;
            usageKnown = false;
          }
          await recordAiRun(
            {
              runId: randomUUID(),
              task: "thumbnail-generation",
              inputVersion: identityHash(input.source),
              provider: provider.id,
              model: provider.model,
              routingReason:
                "Bounded image retry allowance shared with job/day ledger",
              attempt: calls,
              latencyMs: Date.now() - start,
              cost: result?.cost ?? { basis: "unknown" },
              outcome: "failed",
              cacheIdentity: key,
              reservationId: key,
              at: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            },
            deps.store,
          );
          if (error instanceof LeaseLostError || ctx.signal.aborted)
            throw error;
          if (
            (error as { retryable?: boolean }).retryable === false ||
            !retryLeft
          )
            throw terminal(
              error instanceof Error ? error.message : String(error),
            );
          retryLeft--;
        }
      }
    ctx.fenced(() =>
      deps.store.put("thumbnail-image-result", key, { results }),
    );
    return { results };
  } finally {
    await settleAiBudget(
      reservation.id,
      {
        basis: unknown ? "unknown" : "estimated",
        ...(unknown ? {} : { value: totalCost }),
      },
      calls * provider.bounds.requests,
      usageKnown ? tokens : undefined,
      deps.store,
    );
  }
}
export function thumbnailStages(deps = thumbnailDependencies()): WorkStage[] {
  return [
    {
      name: "thumbnail-frames",
      expensive: true,
      timeoutMs: 180_000,
      run: async (ctx) => {
        const input = requestFor(ctx, deps),
          source = await resolveThumbnailSource(input.source, deps);
        if (input.selectedFrameIds?.length)
          return { data: { frames: selectedFrames(input, deps) } };
        const frames = await extractFrameCandidates(source, ctx.signal, {
          directory: ctx.workspace,
          timesUs:
            input.frameTimeUs !== undefined ? [input.frameTimeUs] : undefined,
          finished: input.frameKind === "finished",
        });
        ctx.assert();
        const directory = path.join(
          deps.root,
          "studio",
          "thumbnail-frames",
          identityHash(input.source),
        );
        return {
          data: {
            frames: frames.map((f) => ({
              ...f,
              path: path.join(directory, `${f.id}.jpg`),
            })),
          },
          artifacts: frames.map((f) => ({
            from: f.path,
            to: path.join(directory, `${f.id}.jpg`),
          })),
        };
      },
    },
    {
      name: "thumbnail-frames-ready",
      run: async (ctx) => {
        const input = requestFor(ctx, deps);
        ctx.fenced(() => {
          for (const frame of ctx.data.frames as FrameCandidate[])
            deps.store.put("thumbnail-frames", frame.id, {
              ...frame,
              sourceIdentity: input.source,
            });
        });
      },
    },
    {
      // Automatic requests only: the AI ranks real frames and writes the headline; falls back locally.
      name: "thumbnail-pick",
      timeoutMs: 180_000,
      run: async (ctx) => {
        const input = requestFor(ctx, deps);
        const frames = ctx.data.frames as FrameCandidate[] | undefined;
        if (!aiPicks(input) || !frames?.length) return;
        const clip =
          input.source.kind === "legacy"
            ? deps.store
                .get<JobState>("legacy-jobs", input.source.jobId)
                ?.value.clips.find(
                  (c) =>
                    input.source.kind === "legacy" &&
                    c.n === input.source.clipN,
                )
            : undefined;
        const pick = await pickThumbnail(
          {
            frames,
            title: input.clipContext?.title ?? clip?.title,
            hook: input.clipContext?.hook ?? clip?.hook,
            transcript: input.clipContext?.transcript,
            fallbackHeadline: input.headline,
            directory: ctx.workspace,
          },
          deps.ask,
        );
        ctx.assert();
        return {
          data: {
            frames: pick.frames,
            pick: {
              headline: pick.headline,
              layout: pick.layout,
              by: pick.by,
              reason: pick.reason,
            },
          },
        };
      },
    },
    {
      name: "thumbnail-designs",
      expensive: true,
      timeoutMs: 600_000,
      run: async (ctx) => {
        const input = requestFor(ctx, deps);
        if (input.action === "frames") return;
        await resolveThumbnailSource(input.source, deps);
        const frames = ctx.data.frames as FrameCandidate[];
        if (!frames?.length)
          throw terminal("Select a source frame before generating");
        const pick = ctx.data.pick as
          | {
              headline: string;
              layout?: ThumbnailLayout;
              by: "ai" | "heuristic";
              reason?: string;
            }
          | undefined;
        const headline = pick?.headline || input.headline;
        // The picked layout leads; the other two stay as alternatives.
        const layouts = pick?.layout
          ? [
              pick.layout,
              ...(["bold", "editorial", "minimal"] as const).filter(
                (l) => l !== pick.layout,
              ),
            ]
          : undefined;
        const selected = frames.slice(0, 3);
        for (const frame of selected)
          await trustedPath(frame.path, deps.root, frame.checksum);
        const generated = await imageResults(
            { ...input, headline },
            selected,
            ctx,
            deps,
            layouts,
          ),
          designs: ThumbnailDesign[] = [],
          artifacts: { from: string; to: string }[] = [];
        for (let variant = 0; variant < (input.variantCount ?? 3); variant++) {
          const brief = buildThumbnailBrief({
            headline,
            aspect: input.aspect,
            style: input.style,
            variant,
            layout: layouts?.[variant],
            frames: selected,
          });
          const result = generated.results[variant],
            id = aiCacheIdentity({ work: ctx.lease.id, variant });
          const background = result?.assets.find(
            (a) => a.kind === "background",
          );
          const composed = await composeThumbnail(
            {
              brief,
              frame: selected[variant % selected.length]!,
              directory: path.join(ctx.workspace, `design-${variant}`),
              background: background
                ? {
                    assetId: background.checksum,
                    path: background.path,
                    checksum: background.checksum,
                  }
                : undefined,
            },
            ctx.signal,
          );
          const destination = path.join(deps.root, "studio", "thumbnails", id);
          const versions = composed.versions.map((v) => {
            const to = path.join(destination, `${v.id}.${v.format}`);
            artifacts.push({ from: v.path, to });
            return { ...v, path: to };
          });
          if (background) {
            const to = path.join(
              deps.root,
              "studio",
              "thumbnail-assets",
              `${background.checksum}.png`,
            );
            artifacts.push({ from: background.path, to });
            const layer = composed.layers.find((l) => l.id === "background")!;
            layer.kind = "image";
            layer.assetId = background.checksum;
          }
          const provenance = result
            ? {
                provider: result.provider,
                model: result.model,
                prompt: brief.instructions,
                capability: "reference-image-generation" as const,
                cost: result.cost,
                usage: result.usage,
              }
            : {
                provider: "local",
                model: "none",
                prompt: brief.instructions,
                capability: "local-composition" as const,
              };
          designs.push({
            id,
            name: `${brief.layout} — ${headline}`,
            sourceIdentity: input.source,
            ...(input.source.kind === "project"
              ? {
                  projectId: input.source.projectId,
                  revision: input.source.revision,
                }
              : {
                  legacyClipId: `${input.source.jobId}:${input.source.clipN}`,
                }),
            renderChecksum: input.source.renderChecksum,
            sourceFrames: selected.map((f) => ({
              assetId: f.assetId,
              sourceUs: f.sourceUs,
              checksum: f.checksum,
            })),
            aspectPreset: input.aspect,
            layout: brief.layout,
            layers: composed.layers,
            versions,
            provenance,
            imageGeneration: {
              status: result ? "available" : "unavailable",
              reason: generated.reason,
              accounting: result
                ? deps.settings.usageLimitMode === "provider"
                  ? "verified-provider-bounds"
                  : "application-estimates"
                : "local",
            },
            generationState: "ready",
            reviewState: "pending",
            ...(pick
              ? {
                  pick: {
                    by: pick.by,
                    ...(pick.reason ? { reason: pick.reason } : {}),
                  },
                }
              : {}),
          });
        }
        ctx.assert();
        return {
          data: {
            designs,
            generatedAssets: generated.results
              .flatMap((r) => r?.assets ?? [])
              .map((a) => ({
                id: a.checksum,
                path: path.join(
                  deps.root,
                  "studio",
                  "thumbnail-assets",
                  `${a.checksum}.png`,
                ),
                checksum: a.checksum,
                kind: a.kind,
              })),
          },
          artifacts,
        };
      },
    },
    {
      name: "thumbnail-ready",
      run: async (ctx) => {
        const input = requestFor(ctx, deps);
        ctx.fenced(() => {
          for (const asset of (ctx.data.generatedAssets ?? []) as {
            id: string;
          }[])
            deps.store.put("thumbnail-assets", asset.id, asset);
          for (const design of (ctx.data.designs ?? []) as ThumbnailDesign[])
            deps.store.put("thumbnails", design.id, {
              ...design,
              reviewState: sourceStale(input.source, deps)
                ? "stale"
                : design.reviewState,
            });
        });
      },
    },
    {
      // The best design goes onto the clip's YouTube post while it still waits for review. Never fails the work.
      name: "thumbnail-attach",
      run: async (ctx) => {
        const input = requestFor(ctx, deps);
        const top = (ctx.data.designs as ThumbnailDesign[] | undefined)?.[0];
        if (!aiPicks(input) || !top) return;
        const { autoAttachThumbnail } = await import("./thumbnail-studio");
        try {
          return {
            data: {
              attached: await autoAttachThumbnail(input.source, top.id, deps),
            },
          };
        } catch (error) {
          return {
            data: {
              attachError:
                error instanceof Error ? error.message : String(error),
            },
          };
        }
      },
    },
  ];
}
export function registerThumbnailWorkers() {
  registerWork("thumbnail", () => thumbnailStages());
}
