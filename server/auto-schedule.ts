import { audienceTz } from "../lib/post-time";
import { queueGroup } from "../lib/queue-source";
import { SIMILARITY_STORE, type ClipSimilarity } from "../lib/similarity";
import type { QueueEntry } from "../lib/types";
import { DEFAULT_CONTROLS } from "../lib/creator-policy";
import { runtimeStore } from "./db/runtime";
import { resolvePublicationFiles } from "./poster";
import { approve, queue } from "./queue";
import { effective, loadSettings } from "./settings";

/**
 * Auto-scheduling: a Monitor clip that passes every check is scheduled without waiting for the owner, in a normal
 * slot (so it can still be rejected before it posts). Every check, as the owner set it:
 * - content: at least one AI reviewer says OK and none says block (the combined review is "ok");
 * - similar clips: checked, and not a near-copy of a waiting, scheduled or recent post;
 * - thumbnail: a designed one is attached to the YouTube post;
 * - and everything the normal approval checks (media, destination, policy), via approve() itself.
 */
export function autoScheduleBlockers(
  entries: QueueEntry[],
  similarity: ClipSimilarity | undefined,
): string[] {
  const out: string[] = [];
  const review = entries.find((e) => e.aiReview)?.aiReview;
  const caution = effective().autoScheduleCaution;
  if (!review || review.verdict === "block" || (review.verdict === "caution" && !caution))
    out.push(
      review?.verdict === "block"
        ? "An AI reviewer said don't post it"
        : "The AI reviewers didn't clear it (at least one OK, no block)",
    );
  if (!similarity || similarity.checking !== undefined || !similarity.checkedAt)
    out.push("The similar-clips check hasn't finished");
  else if (!similarClear(similarity))
    out.push("It looks like another of your clips");
  const yt = entries.find((e) => e.platform === "youtube");
  if (yt && !yt.publishPackage?.thumbnail?.designId)
    out.push("No designed thumbnail is attached yet");
  return out;
}

/** Nothing close, or an AI judged it distinct and none called it a near-duplicate. */
export function similarClear(s: ClipSimilarity): boolean {
  if (s.verdict.level === "distinct") return true;
  return (
    s.opinions.some((o) => o.level === "distinct") &&
    !s.opinions.some((o) => o.level === "near-duplicate")
  );
}

const automated = (e: QueueEntry) =>
  !!e.jobId &&
  !e.source &&
  !!runtimeStore().get("automation-jobs", e.jobId);

/** One pass: schedule every waiting Monitor clip with no blockers. Returns the titles scheduled. */
export async function autoScheduleSweep(now = new Date()): Promise<string[]> {
  if (!effective().autoSchedule) return [];
  const c = loadSettings().automationControls ?? DEFAULT_CONTROLS;
  if (c.globalStop || c.postPaused || effective().postingPaused) return [];
  const groups = new Map<string, QueueEntry[]>();
  for (const e of queue().list())
    if (e.status === "review" && automated(e))
      groups.set(queueGroup(e), [...(groups.get(queueGroup(e)) ?? []), e]);
  const done: string[] = [];
  for (const [group, entries] of groups) {
    const similarity = runtimeStore().get<ClipSimilarity>(SIMILARITY_STORE, group)?.value;
    if (autoScheduleBlockers(entries, similarity).length) continue;
    const prepared = await Promise.all(
      entries.map(async (e) => {
        const files = await resolvePublicationFiles(e);
        return { ...e, publicationFiles: typeof files === "object" ? files : undefined };
      }),
    );
    let scheduled: QueueEntry[] = [];
    queue().mutate((all) => {
      // the queue may have moved on while files were resolved: only act on entries still waiting, unchanged
      const fresh = all.filter((x) => queueGroup(x) === group && x.status === "review");
      if (
        fresh.length !== entries.length ||
        fresh.some((x) => x.updatedAt !== entries.find((e) => e.key === x.key)?.updatedAt)
      )
        return all;
      const ready = all.map((x) => prepared.find((p) => p.key === x.key) ?? x);
      const r = approve(ready, "", undefined, {
        group,
        automatic: true,
        audienceTz: audienceTz(effective().postingAudience),
        now,
      });
      scheduled = r.scheduled;
      return r.scheduled.length ? r.entries : all;
    });
    if (scheduled.length) done.push(scheduled[0]!.clipTitle);
  }
  return done;
}

let last = 0;
/** Maintenance hook: at most one pass every 30 seconds. */
export async function maybeAutoSchedule(now = Date.now()) {
  if (now - last < 30_000) return;
  last = now;
  await autoScheduleSweep(new Date(now)).catch((e) =>
    console.error("[auto-schedule]", e instanceof Error ? e.message : e),
  );
}
