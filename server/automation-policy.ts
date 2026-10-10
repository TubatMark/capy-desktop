import { assertAiBudgetAvailable, getAiUsage } from "./ai-usage";
import { createHash } from "node:crypto";
import {
  DEFAULT_CONTROLS,
  DEFAULT_CREATOR_POLICY,
  CreatorPolicySchema,
  MediaQualityReportSchema,
  type CreatorPolicy,
  type CreatorWorkInput,
  type WorkDecision,
  type CreatorRecipe,
  type MediaQualityReport,
} from "../lib/creator-policy";
import type { JobSettings, QueueEntry, JobState, WatchedChannel } from "../lib/types";
import { effective, loadSettings, saveSettings } from "./settings";
import { runtimeStore } from "./db/runtime";
import { loadReadingAccount, publicAccounts } from "./accounts";
import { watch } from "./watch";
import type {
  ThumbnailDesign,
  ThumbnailStudioDocument,
} from "../lib/thumbnails";
import {
  thumbnailProvenanceComplete,
  thumbnailReviewManifest,
} from "../lib/thumbnails";
import { hashManifest } from "./publication-policy";
import { fence } from "./worker/context";
import { footageCurrent } from "./thumbnail-footage";
export function planCreatorWork(input: CreatorWorkInput): WorkDecision {
  const { candidate: c, policy: p, capacity: b } = input;
  const result = (
    kind: WorkDecision["kind"],
    reason: string,
  ): WorkDecision => ({
    kind,
    candidateId: c.id,
    reason,
    budget: { clips: kind === "proceed" ? p.clips : 0 },
    destination:
      input.destinationAccountId ??
      (p.mode === "automatic_drafts" && !p.destinationAccountIds.length
        ? "local-drafts"
        : undefined),
    recipe: kind === "proceed" ? recipeFor(p) : undefined,
  });
  if (input.manual)
    return result(
      "proceed",
      "Manual import requested; automated intake capacity does not apply",
    );
  if (input.existingJobConflict)
    return result("defer", input.existingJobConflict);
  if (p.mode === "disabled")
    return result("skip", "Creator automation is disabled");
  if (p.mode === "manual")
    return result("defer", "Manual mode: waiting for a user import");
  if (!input.sourceAllowed)
    return result(
      "defer",
      "Source reading permission is unavailable; reconnect the original reading account",
    );
  if (p.destinationAccountIds.includes(c.channelId))
    return result(
      "skip",
      "Publishing destination channels cannot feed creator automation",
    );
  if (
    (!input.destinationAccountId ||
      !p.destinationAccountIds.includes(input.destinationAccountId)) &&
    !(
      p.mode === "automatic_drafts" &&
      !p.destinationAccountIds.length &&
      (!input.destinationAccountId ||
        input.destinationAccountId === "local-drafts")
    )
  )
    return result("defer", "Select a connected publishing destination");
  if (c.sourceMethod && !p.sourceMethods.includes(c.sourceMethod))
    return result(
      "defer",
      "Source method is not permitted by this creator recipe",
    );
  if (c.isArchive && !p.allowArchives)
    return result(
      "skip",
      "Finished stream archives are excluded by this creator recipe",
    );
  if (
    !p.allowShortSources &&
    c.durationSec !== undefined &&
    c.durationSec <= 180
  )
    return result(
      "skip",
      "Short source duration (180 seconds or less) is excluded; this is a duration rule, not a Shorts-format classifier",
    );
  if (c.durationSec === undefined)
    return result("defer", "Waiting for an exact source duration");
  if (c.durationSec < p.minDurationSec || c.durationSec > p.maxDurationSec)
    return result(
      "skip",
      "Source duration is outside the configured creator range",
    );
  const title = c.title.toLowerCase();
  if (p.excludeTopics.some((t) => title.includes(t.toLowerCase())))
    return result("skip", "Source title matches an excluded topic");
  if (
    p.includeTopics.length &&
    !p.includeTopics.some((t) => title.includes(t.toLowerCase()))
  )
    return result(
      "skip",
      "Source title does not match the configured included topics",
    );
  if (input.now - (c.publishedAt ?? c.foundAt) > p.freshnessHours * 3600000)
    return result(
      p.expireFreshness ? "skip" : "defer",
      p.expireFreshness
        ? "Source expired under the explicit freshness policy"
        : "Source exceeds freshness window; waiting for explicit backfill",
    );
  const used = b.unpublished + b.reservedClips;
  if (
    used + p.clips >
      Math.min(
        b.destinationDailySlots * b.targetDays,
        b.destinationDailySlots * b.maxBacklogDays,
      ) ||
    p.clips > b.remainingRenderClips
  )
    return result(
      "defer",
      "Destination calendar, unpublished backlog or daily render budget is at capacity",
    );
  return result(
    "proceed",
    "Creator recipe admitted within destination and daily clip capacity",
  );
}
export function rankCreatorWork(inputs: CreatorWorkInput[]): WorkDecision[] {
  let reserved = 0;
  return [...inputs]
    .sort(
      (a, b) =>
        (b.candidate.priority ?? 0) - (a.candidate.priority ?? 0) ||
        a.candidate.foundAt - b.candidate.foundAt ||
        a.candidate.id.localeCompare(b.candidate.id),
    )
    .map((i) => {
      const d = planCreatorWork({
        ...i,
        capacity: {
          ...i.capacity,
          reservedClips: i.capacity.reservedClips + reserved,
          remainingRenderClips: Math.max(
            0,
            i.capacity.remainingRenderClips - reserved,
          ),
        },
      });
      if (d.kind === "proceed" && !i.manual) reserved += d.budget.clips;
      return d;
    });
}
function recipeFor(p: CreatorPolicy): CreatorRecipe {
  const data = {
    version: 1 as const,
    editTemplate: p.editTemplate,
    thumbnailTemplate: p.thumbnailTemplate,
    clips: p.clips,
    language: p.language,
  };
  return {
    ...data,
    id: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    createdAt: Date.now(),
  };
}
export const recipeIdForPolicy = (p: CreatorPolicy) => recipeFor(p).id;
export interface CreatorJobAdmission {
  channelId: string;
  recipeId: string;
  clips: number;
  at: number;
  destination?: string;
  sourceAccountId?: string;
  sourceMethod?: "uploads-playlist" | "videos-tab";
}
export class AutomationIntakeDeferredError extends Error {}
/** Existing jobs are never implicitly adopted; only the same active immutable admission may resume. */
export function existingAutomationIntakeReason(
  existing: JobState | undefined,
  incoming: { channelId: string; recipeId?: string },
): string | undefined {
  if (!existing) return;
  const store = runtimeStore();
  const link = store.get<{ channelId: string; recipeId: string }>(
    "automation-jobs",
    existing.id,
  )?.value;
  const admission = store.get<{ channelId: string; clips: number }>(
    "automation-admissions",
    existing.id,
  )?.value;
  if (!existing.automation || !link || !admission)
    return "Existing manual or completed job owns this source; automatic intake is deferred to preserve its settings, selected clips and approvals";
  if (
    link.channelId !== incoming.channelId ||
    link.recipeId !== incoming.recipeId ||
    existing.automation.channelId !== link.channelId ||
    existing.automation.recipeId !== link.recipeId ||
    admission.channelId !== link.channelId
  )
    return "Existing automated job has a different immutable recipe or admission; preserve its saved work and review it manually";
  const recipe = creatorRecipe(link.recipeId);
  if (
    !recipe ||
    admission.clips !== recipe.clips ||
    existing.clips.filter((c) => c.selected).length > recipe.clips
  )
    return "Existing automated selections exceed or disagree with their immutable clip admission; automatic work is deferred";
  const expected = recipeSettings(recipe);
  if (
    Object.entries(expected).some(
      ([key, value]) => existing.settings[key as keyof JobSettings] !== value,
    ) ||
    (existing.settings.lang ?? "") !== recipe.language
  )
    return "Existing automated job settings were edited after admission; automatic work is deferred to preserve those edits";
}
export function recordCreatorJobAdmission(
  jobId: string,
  admission: CreatorJobAdmission,
) {
  const store = runtimeStore();
  const recipe = creatorRecipe(admission.recipeId);
  if (!recipe || admission.clips !== recipe.clips)
    throw new AutomationIntakeDeferredError(
      "Creator admission does not match its immutable recipe; automatic intake is deferred",
    );
  const prior = store.get<{ channelId: string; recipeId: string }>(
    "automation-jobs",
    jobId,
  )?.value;
  const receipt = store.get<{ channelId: string; clips: number }>(
    "automation-admissions",
    jobId,
  )?.value;
  if (prior || receipt) {
    if (
      !prior ||
      !receipt ||
      prior.channelId !== admission.channelId ||
      prior.recipeId !== admission.recipeId ||
      receipt.channelId !== admission.channelId ||
      receipt.clips !== admission.clips
    )
      throw new AutomationIntakeDeferredError(
        "Existing immutable automation admission changed; automatic intake is deferred",
      );
    return;
  }
  store.put("automation-jobs", jobId, {
    channelId: admission.channelId,
    recipeId: admission.recipeId,
    sourceAccountId: admission.sourceAccountId,
    sourceMethod: admission.sourceMethod,
  });
  store.put("automation-admissions", jobId, {
    channelId: admission.channelId,
    clips: admission.clips,
    at: admission.at,
    destination: admission.destination,
  });
}
export function creatorRecipe(id: string) {
  return runtimeStore().get<CreatorRecipe>("creator-recipes", id)?.value;
}
export function saveCreatorPolicy(
  channelId: string,
  value: unknown,
): CreatorPolicy {
  const p = CreatorPolicySchema.parse(value);
  if (p.mode === "automatic_publish")
    throw Error(
      "Automatic publication remains disabled pending a real 72-hour fault soak and separately authorized upload",
    );
  const recipe = recipeFor(p);
  const saved = { ...p, recipeId: recipe.id };
  runtimeStore().transaction(() => {
    if (!creatorRecipe(recipe.id))
      runtimeStore().put("creator-recipes", recipe.id, recipe);
    saveSettings({
      creatorPolicies: {
        ...loadSettings().creatorPolicies,
        [channelId]: saved,
      },
    });
    watch().mutate((f) => ({
      ...f,
      channels: f.channels.map((c) =>
        c.id === channelId
          ? {
              ...c,
              settings: {
                ...c.settings,
                clips: p.clips,
                minVideoSec: p.minDurationSec,
              },
            }
          : c,
      ),
    }));
  });
  return saved;
}
/** Connected publishing accounts a channel without saved options posts to. */
export function connectedDestinationIds(): string[] {
  return publicAccounts()
    .filter((a) => a.connected && !a.needsReconnect && a.account?.id)
    .map((a) => a.account!.id);
}
/** What a channel runs with until its options are saved: the same policy the watcher clips it with, so the
 *  clips it makes can also be posted. */
export function unsavedCreatorPolicy(
  c: Pick<WatchedChannel, "settings">,
  destinationIds = connectedDestinationIds(),
): CreatorPolicy {
  return {
    ...DEFAULT_CREATOR_POLICY,
    mode: "automatic_drafts",
    clips: c.settings.clips,
    minDurationSec: c.settings.minVideoSec,
    destinationAccountIds: ["local-drafts", ...destinationIds],
    requireModelReview: true,
    // Every automated clip gets designed thumbnails; saved options keep their own choice.
    thumbnailGeneration: "automatic",
  };
}
export function creatorPolicy(channelId: string): CreatorPolicy {
  const saved = loadSettings().creatorPolicies?.[channelId];
  if (saved) return saved;
  const channel = watch()
    .get()
    .channels.find((c) => c.id === channelId);
  return channel ? unsavedCreatorPolicy(channel) : DEFAULT_CREATOR_POLICY;
}
export function recipeSettings(recipe: CreatorRecipe): Partial<JobSettings> {
  return {
    count: recipe.clips,
    style: recipe.editTemplate === "clean-portrait-v1" ? "clean" : "bold",
    layout: "center",
    captions: true,
    hook: true,
    ...(recipe.language ? { lang: recipe.language } : {}),
  };
}
/** Count downloadable local drafts as backlog even when no publishing account is connected. */
export function unpublishedAutomatedClips(excludeJobId?: string): number {
  const store = runtimeStore(),
    all = store.get<QueueEntry[]>("legacy-state", "queue")?.value ?? [];
  const terminal = new Set(
    all
      .filter((e) => ["posted", "rejected"].includes(e.status))
      .map((e) => `${e.jobId}:${e.n}`),
  );
  const pending = new Set(
    all
      .filter(
        (e) =>
          e.jobId !== excludeJobId &&
          !["posted", "rejected"].includes(e.status),
      )
      .map((e) => (e.source ? e.key : `${e.jobId}:${e.n}`)),
  );
  for (const row of store.list<JobState>("legacy-jobs")) {
    if (row.id === excludeJobId || !store.get("automation-jobs", row.id))
      continue;
    for (const clip of row.value.clips ?? [])
      if (
        ["done", "stale"].includes(clip.render.status) &&
        !terminal.has(`${row.id}:${clip.n}`)
      )
        pending.add(`${row.id}:${clip.n}`);
  }
  return pending.size;
}
export function admissionReasons(job: {
  kind: string;
  payload?: Record<string, unknown>;
}): string[] {
  const s = loadSettings(),
    c = s.automationControls ?? DEFAULT_CONTROLS;
  if (c.globalStop) return ["Global stop: future worker stages are stopped"];
  // comparing queue clips is a small text-only AI task, not media work
  if (job.kind === "similarity") return [];
  if (job.kind === "watcher")
    return c.monitorPaused ? ["Creator monitoring is paused"] : [];
  if (job.kind === "poster")
    return c.postPaused || s.postingPaused ? ["Posting is paused"] : [];
  if (c.renderPaused) return ["Media and rendering work is paused"];
  const automatic =
    job.payload?.automated === true ||
    (job.payload?.request as { mode?: string } | undefined)?.mode ===
      "automatic";
  const jobId =
    automatic && typeof job.payload?.jobId === "string"
      ? job.payload.jobId
      : undefined;
  const link = jobId
    ? runtimeStore().get<{
        channelId: string;
        recipeId: string;
        sourceAccountId?: string;
        sourceMethod?: "uploads-playlist" | "videos-tab";
      }>("automation-jobs", jobId)?.value
    : undefined;
  if (link) {
    const policy = s.creatorPolicies?.[link.channelId];
    const channel = watch()
      .get()
      .channels.find((ch) => ch.id === link.channelId);
    if (!channel?.enabled)
      return [
        "Creator monitoring is disabled; saved automated work is waiting",
      ];
    if (policy && ["disabled", "manual"].includes(policy.mode))
      return [
        "Creator recipe is disabled or manual; automated media work is waiting",
      ];
    if (
      link.sourceMethod &&
      policy &&
      !policy.sourceMethods.includes(link.sourceMethod)
    )
      return [
        "Original reading method is no longer permitted by the creator recipe",
      ];
    if (policy?.recipeId && policy.recipeId !== link.recipeId)
      return ["Creator recipe changed; saved media work needs attention"];
    const reader = loadReadingAccount();
    if (
      link.sourceAccountId &&
      (!reader.tokens?.accessToken ||
        reader.needsReconnect ||
        reader.account?.id !== link.sourceAccountId)
    )
      return ["Original source reading permission is unavailable"];
    const p = policy ?? DEFAULT_CREATOR_POLICY;
    if (job.kind === "media" && job.payload?.operation === "analyze") {
      try {
        assertAiBudgetAvailable(jobId);
      } catch (error) {
        return [
          error instanceof Error ? error.message : "AI budget is unavailable",
        ];
      }
      const jobBudget =
        runtimeStore().get<{ usd: number }>("ai-budget-job", jobId!)?.value
          .usd ?? 0;
      if (getAiUsage().usd >= p.maxDayUsd || jobBudget >= p.maxJobUsd)
        return [
          "Creator AI allowance is exhausted; source processing is deferred before costly media work",
        ];
    }
    const backlog = unpublishedAutomatedClips(jobId);
    const own = creatorRecipe(link.recipeId)?.clips;
    if (own === undefined) return ["Immutable creator recipe is missing"];
    if (
      backlog + own >
      p.destinationDailySlots * Math.min(p.targetQueueDays, p.maxBacklogDays)
    )
      return [
        "Destination calendar capacity changed; automated media work is deferred before rendering",
      ];
  }
  return [];
}
export function saveWorkDecision(channelId: string, d: WorkDecision) {
  fence(() =>
    runtimeStore().put(
      "automation-decisions",
      `${channelId}:${d.candidateId}`,
      { ...d, channelId, at: Date.now() },
    ),
  );
}
/** File selection only; publication authorization remains in evaluatePublication. */
export function automationPublicationFiles<
  T extends { file: string; thumbFile?: string },
>(e: QueueEntry, files: T): T {
  const link = e.jobId
    ? runtimeStore().get<{ channelId: string }>("automation-jobs", e.jobId)
        ?.value
    : undefined;
  if (!link) return files;
  const p = creatorPolicy(link.channelId),
    thumbnail = e.publishPackage?.thumbnail;
  if (
    !p.thumbnailRequired &&
    p.optionalThumbnailFallback === "none" &&
    !(
      thumbnail?.designId &&
      thumbnail.versionId &&
      thumbnail.sourceIdentity &&
      (thumbnail.sourceFrame || thumbnail.sourceThumbnail)
    )
  ) {
    const { thumbFile: _omitted, ...selected } = files;
    return selected as T;
  }
  return files;
}
/** Included inside the immutable package hash and checked by the central policy-version equality. */
export function automationPublicationPolicyVersion(
  e: QueueEntry,
  base: string,
): string {
  const link = e.jobId
    ? runtimeStore().get<{
        channelId: string;
        recipeId: string;
        sourceAccountId?: string;
        sourceMethod?: string;
      }>("automation-jobs", e.jobId)?.value
    : undefined;
  return link
    ? `${base}:creator:${hashManifest({ policy: creatorPolicy(link.channelId), source: link })}`
    : base;
}
/** Evidence only: evaluatePublication is the sole publication authority. */
export function getAutomationPublicationChecks(e: QueueEntry): {
  required: boolean;
  reasons: string[];
} {
  if (!e.jobId) return { required: false, reasons: [] };
  // Jobs are legacy documents; the persisted policy link is stored separately from transient automation.
  const link = runtimeStore().get<{
    channelId: string;
    recipeId: string;
    sourceAccountId?: string;
    sourceMethod?: "uploads-playlist" | "videos-tab";
  }>("automation-jobs", e.jobId)?.value;
  if (!link) return { required: false, reasons: [] };
  const p = creatorPolicy(link.channelId),
    pkg = e.publishPackage;
  const reasons: string[] = [];
  if (!pkg) {
    return {
      required: true,
      reasons: ["Current publication package is missing"],
    };
  }
  const parsedReport = MediaQualityReportSchema.safeParse(
    runtimeStore().get<MediaQualityReport>(
      "media-quality",
      pkg.artifact.checksum,
    )?.value,
  );
  const report = parsedReport.success ? parsedReport.data : undefined;
  if (
    !report ||
    report.policy?.maxBlackRatio !== p.maxBlackRatio ||
    report.policy?.maxFrozenRatio !== p.maxFrozenRatio ||
    report.policy?.requireAudio !== p.requireAudio ||
    report.policy?.aspect !== "portrait" ||
    report.reviewVersion !== "deterministic-media-v1" ||
    report.checksum !== pkg.artifact.checksum ||
    report.revision !== (pkg.artifact.revision ?? 0)
  )
    reasons.push("Current media quality report is missing or stale");
  else if (!report.passed)
    reasons.push(...report.checks.filter((c) => !c.pass).map((c) => c.reason));
  // Your approval of this exact package is the human check when the AI asked for one or couldn't run;
  // an AI "block" still needs the explicit override, which evaluatePublication enforces.
  const approved = e.publicationDecision?.packageHash === pkg.packageHash;
  // auto-scheduled under the owner's "check this is fine" setting counts like their approval (never for a block)
  const acceptedCaution =
    !!e.autoScheduledAt &&
    effective().autoSchedule &&
    effective().autoScheduleCaution &&
    pkg.review?.verdict === "caution";
  if (
    p.requireModelReview &&
    (!pkg.review || pkg.review.verdict !== "ok") &&
    !approved &&
    !acceptedCaution
  )
    reasons.push(
      "The AI review flagged this clip or couldn't run; read it, then approve",
    );
  const channel = watch()
    .get()
    .channels.find((c) => c.id === link.channelId);
  const reader = loadReadingAccount();
  const sourceAccountId = link.sourceAccountId ?? channel?.sourceAccountId;
  if (
    sourceAccountId &&
    (!reader.tokens?.accessToken ||
      reader.needsReconnect ||
      reader.account?.id !== sourceAccountId)
  )
    reasons.push("Original source reading permission is unavailable");
  if (link.sourceMethod && !p.sourceMethods.includes(link.sourceMethod))
    reasons.push(
      "Original reading method is no longer permitted by the creator recipe",
    );
  if (!creatorRecipe(link.recipeId))
    reasons.push("Immutable creator recipe is unavailable");
  if (p.recipeId && p.recipeId !== link.recipeId)
    reasons.push(
      "Creator recipe changed; current package needs renewed checks",
    );
  if (pkg.thumbnail?.designId) {
    const row = runtimeStore().get<ThumbnailDesign>(
      "thumbnails",
      pkg.thumbnail.designId,
    );
    type Attachment = {
      editRevision: number;
      checksum: string;
      versionId: string;
    };
    // Re-approval after a text edit rebuilds the package under a new hash; the exact version still matches.
    const attachment =
      runtimeStore().get<Attachment>("thumbnail-attachments", pkg.packageHash)
        ?.value ??
      (pkg.thumbnail.versionId
        ? runtimeStore().get<Attachment>(
            "thumbnail-attachments",
            `version:${pkg.thumbnail.versionId}`,
          )?.value
        : undefined);
    const selected =
      attachment && row
        ? row.revision === attachment.editRevision
          ? { ...row.value, editRevision: row.revision }
          : runtimeStore().get<ThumbnailStudioDocument>(
              "thumbnail-history",
              `${pkg.thumbnail.designId}:${attachment.editRevision}`,
            )?.value
        : undefined;
    const audit = attachment
      ? runtimeStore().get<{ digest: string; state: string }>(
          "thumbnail-reviews",
          `${pkg.thumbnail.designId}:${attachment.editRevision}`,
        )?.value
      : undefined;
    const source = pkg.thumbnail.sourceIdentity;
    const matches =
      !!source &&
      footageCurrent(source, runtimeStore()) &&
      selected &&
      hashManifest(selected.sourceIdentity) === hashManifest(source) &&
      source?.renderChecksum === pkg.artifact.checksum;
    const frame = pkg.thumbnail.sourceFrame,
      original = pkg.thumbnail.sourceThumbnail;
    // Frame designs must name one of their frames; "original" designs the exact source-video thumbnail.
    const provenanceMatches =
      !!selected &&
      thumbnailProvenanceComplete(
        selected,
        source?.kind === "legacy"
          ? runtimeStore().get<JobState>("legacy-jobs", source.jobId)?.value
              .videoId
          : undefined,
      ) &&
      (selected.sourceThumbnail
        ? !frame &&
          !!original &&
          original.videoId === selected.sourceThumbnail.videoId &&
          original.url === selected.sourceThumbnail.url &&
          original.checksum === selected.sourceThumbnail.checksum
        : !original &&
          !!frame &&
          selected.sourceFrames.some(
            (f) =>
              f.assetId === frame.assetId &&
              f.sourceUs === frame.sourceUs &&
              f.checksum === frame.checksum,
          ));
    if (
      !selected ||
      !attachment ||
      attachment.checksum !== pkg.thumbnail.checksum ||
      attachment.versionId !== pkg.thumbnail.versionId ||
      selected.generationState !== "ready" ||
      selected.reviewState === "stale" ||
      selected.reviewState === "blocked" ||
      !matches ||
      !provenanceMatches
    )
      reasons.push(
        "Selected thumbnail revision, provenance or composition is stale or failed",
      );
    if (
      p.thumbnailRequired &&
      (!selected ||
        audit?.state !== "approved" ||
        audit.digest !== hashManifest(thumbnailReviewManifest(selected)))
    )
      reasons.push("Required thumbnail is waiting for explicit approval");
  }
  if (p.thumbnailRequired && !pkg.thumbnail)
    reasons.push("Creator requires an approved current thumbnail");
  if (p.thumbnailRequired && pkg.thumbnail && !pkg.thumbnail.versionId)
    reasons.push("Creator requires an exact approved thumbnail version");
  if (
    !p.thumbnailRequired &&
    !(
      pkg.thumbnail?.designId &&
      pkg.thumbnail.versionId &&
      pkg.thumbnail.sourceIdentity &&
      (pkg.thumbnail.sourceFrame || pkg.thumbnail.sourceThumbnail)
    ) &&
    p.optionalThumbnailFallback !== "none"
  )
    reasons.push(
      "Configured source-frame fallback has not been attached with exact provenance",
    );
  if (!p.destinationAccountIds.includes(pkg.accountId))
    reasons.push(
      "This channel's options don't allow posting to this account (Monitor → More options → Post to)",
    );
  return { required: true, reasons };
}
