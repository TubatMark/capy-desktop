import { createHash } from "node:crypto";
import { hashManifest, hashFile } from "./publication-policy";
import {
  creatorPolicy,
  creatorRecipe,
  recipeSettings,
} from "./automation-policy";
import { runtimeStore } from "./db/runtime";
import { currentWork, fence } from "./worker/context";
import {
  RenderInputSchema,
  RenderProofSchema,
  type RenderAttributionInput,
  type RenderAttributionProof,
} from "../lib/performance";
import type { JobState, ClipState } from "../lib/types";
import { normalizeLook } from "../lib/look";
import { run } from "../src/exec";
/** Called before stageRender; immutable input survives the subsequent mutable job and policy. */
export function captureRenderInputs(
  job: JobState,
  clip: ClipState,
): RenderAttributionInput {
  const settings = {
    count: job.settings.count,
    minSec: job.settings.minSec,
    maxSec: job.settings.maxSec,
    layout: job.settings.layout,
    style: job.settings.style,
    captions: job.settings.captions,
    hook: job.settings.hook,
    lang: job.settings.lang,
    audience: job.settings.audience,
    lookHash: hashManifest(
      normalizeLook(job.settings.look, job.settings.style),
    ),
  };
  let recipe: RenderAttributionInput["recipe"] = {
    state: "manual",
    reason: "Explicit local rendering without an active creator recipe",
  };
  if (job.automation) {
    recipe = {
      state: "unattributed",
      reason: "Actual render settings do not prove the admitted creator recipe",
    };
    const link = runtimeStore().get<{ channelId: string; recipeId: string }>(
      "automation-jobs",
      job.id,
    )?.value;
    const definition = job.automation.recipeId
      ? creatorRecipe(job.automation.recipeId)
      : undefined;
    if (
      link &&
      definition &&
      link.channelId === job.automation.channelId &&
      link.recipeId === definition.id
    ) {
      const expected = recipeSettings(definition),
        policy = creatorPolicy(link.channelId);
      const identity = {
        version: definition.version,
        editTemplate: definition.editTemplate,
        thumbnailTemplate: definition.thumbnailTemplate,
        clips: definition.clips,
        language: definition.language,
      };
      if (
        createHash("sha256").update(JSON.stringify(identity)).digest("hex") ===
          definition.id &&
        Object.entries(expected).every(
          ([k, v]) => job.settings[k as keyof typeof job.settings] === v,
        ) &&
        (!policy.recipeId || policy.recipeId === definition.id)
      )
        recipe = {
          state: "attributed",
          recipeId: definition.id,
          definition: structuredClone(definition),
          policyHash: hashManifest(policy),
          policy: structuredClone(policy),
          settings,
        };
    }
  }
  const work = currentWork();
  const body = {
    version: 1 as const,
    capturedAt: Date.now(),
    jobId: job.id,
    clipN: clip.n,
    sourceVideoId: job.videoId,
    creatorId: job.automation?.channelId,
    sourceStartUs: Math.round(clip.start * 1e6),
    sourceEndUs: Math.round(clip.end * 1e6),
    settings,
    recipe,
    worker: work
      ? { id: work.lease.id, generation: work.lease.generation }
      : undefined,
  };
  const input = RenderInputSchema.parse({
    ...body,
    inputHash: hashManifest(body),
  });
  fence(() =>
    runtimeStore().transaction(() => {
      const prior = runtimeStore().get(
        "render-attribution-inputs",
        input.inputHash,
      );
      if (prior && hashManifest(prior.value) !== hashManifest(input))
        throw Error("Render input integrity failure");
      if (!prior)
        runtimeStore().put("render-attribution-inputs", input.inputHash, input);
    }),
  );
  return input;
}
/** Probe generation bytes before promotion; finalization checks the promoted checksum independently. */
export async function measureRenderedAttribution(file: string) {
  const checksum = hashFile(file);
  if (!checksum) throw Error("Rendered attribution media missing");
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
    { timeoutMs: 30000 },
  );
  const durationUs = Math.round(
    Number(JSON.parse(stdout).format?.duration) * 1e6,
  );
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0)
    throw Error("Rendered attribution duration unavailable");
  return { checksum, durationUs };
}
export function recordSuccessfulRender(
  input: RenderAttributionInput,
  promotedFile: string,
  output: { checksum: string; durationUs: number },
): RenderAttributionProof {
  return fence(() =>
    runtimeStore().transaction(() => {
      const parsed = RenderInputSchema.parse(input),
        { inputHash, ...body } = parsed;
      if (
        hashManifest(body) !== inputHash ||
        hashManifest(
          runtimeStore().get("render-attribution-inputs", inputHash)?.value,
        ) !== hashManifest(parsed)
      )
        throw Error("Render input integrity failure");
      const work = currentWork();
      if (
        parsed.worker &&
        (!work ||
          work.lease.id !== parsed.worker.id ||
          work.lease.generation !== parsed.worker.generation)
      )
        throw Error("Render worker generation changed");
      if (hashFile(promotedFile) !== output.checksum)
        throw Error("Promoted render checksum mismatch");
      const proofBody = {
          version: 1 as const,
          input: parsed,
          ...output,
          completedAt: Date.now(),
        },
        proof = RenderProofSchema.parse({
          ...proofBody,
          proofHash: hashManifest(proofBody),
        }),
        key = proofKey(parsed.jobId, parsed.clipN, output.checksum);
      const existing = getRenderProof(
        parsed.jobId,
        parsed.clipN,
        output.checksum,
      );
      if (existing) {
        if (
          existing.input.inputHash !== parsed.inputHash &&
          hashManifest({
            ...existing.input,
            inputHash: undefined,
            capturedAt: undefined,
            worker: undefined,
          }) !==
            hashManifest({
              ...parsed,
              inputHash: undefined,
              capturedAt: undefined,
              worker: undefined,
            })
        )
          throw Error("Conflicting exact render proof");
        return existing;
      }
      runtimeStore().put("render-attribution-proofs", key, proof);
      return proof;
    }),
  );
}
const proofKey = (jobId: string, n: number, checksum: string) =>
  JSON.stringify([jobId, n, checksum]);
export function getRenderProof(
  jobId: string,
  n: number,
  checksum: string,
): RenderAttributionProof | undefined {
  const row = runtimeStore().get(
    "render-attribution-proofs",
    proofKey(jobId, n, checksum),
  );
  if (!row) return;
  const proof = RenderProofSchema.parse(row.value),
    { proofHash, ...body } = proof,
    { inputHash, ...input } = proof.input;
  if (
    hashManifest(body) !== proofHash ||
    hashManifest(input) !== inputHash ||
    proof.input.jobId !== jobId ||
    proof.input.clipN !== n ||
    proof.checksum !== checksum
  )
    throw Error("Render proof integrity failure");
  return proof;
}
