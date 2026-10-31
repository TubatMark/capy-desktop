import { audienceTz } from "../lib/post-time";
import { creatorName } from "../lib/longform";
import { alternateByTest } from "../lib/shorts-test";
import { queueGroup } from "../lib/queue-source";
import { SIMILARITY_STORE, type ClipSimilarity } from "../lib/similarity";
import type { QueueEntry } from "../lib/types";
import { DEFAULT_CONTROLS } from "../lib/creator-policy";
import { runtimeStore } from "./db/runtime";
import { resolvePublicationFiles } from "./poster";
import { approve, bumpOlderPost, expireLatePosts, note, queue } from "./queue";
import { loadTuning } from "./daily-check";
import { entrySourceAt } from "./source-age";
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
    out.push("An AI says it's a near-copy of another of your clips");
  const yt = entries.find((e) => e.platform === "youtube");
  if (yt && !yt.publishPackage?.thumbnail?.designId)
    out.push("No designed thumbnail is attached yet");
  return out;
}

/**
 * Not a near-copy: the check ran (or nothing was close) and no AI called it a near-duplicate. "Similar" is fine:
 * clips of the same upload already go out on different days.
 */
export function similarClear(s: ClipSimilarity): boolean {
  if (s.verdict.level === "unchecked") return false;
  return s.verdict.level !== "near-duplicate" && !s.opinions.some((o) => o.level === "near-duplicate");
}

/** Interest in a clip fades with its original: past this, it isn't worth a slot. */
export const STALE_MS = 3 * 86_400_000;
const newest = (entries: QueueEntry[]) => Math.max(...entries.map(entrySourceAt));

/** Which side of the narrated Shorts test a post's clip is on, if any. */
function shortTestGroupOf(e: QueueEntry): string | undefined {
  if (!e.jobId) return undefined;
  const job = runtimeStore().get<{ clips?: { n: number; shortTest?: { group: string } }[] }>("legacy-jobs", e.jobId)?.value;
  return job?.clips?.find((c) => c.n === e.n)?.shortTest?.group;
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
  // the clip of the newest original gets the next free slot; once an original is over 3 days old its clips aren't worth
  // a slot, and leaving them waiting would hold the backlog full so no new upload gets clipped
  const stale = [...groups].filter(([, entries]) => now.getTime() - newest(entries) >= STALE_MS);
  if (stale.length) {
    const keys = new Set(stale.flatMap(([, entries]) => entries.map((e) => e.key)));
    queue().mutate((all) =>
      all.map((x) =>
        keys.has(x.key) && x.status === "review"
          ? note({ ...x, status: "rejected" }, "Expired: the original video is more than 3 days old and no free day came up", now)
          : x,
      ),
    );
  }
  queue().mutate((all) => expireLatePosts(all, STALE_MS, now));
  const fresh = [...groups].filter(([, entries]) => now.getTime() - newest(entries) < STALE_MS);
  // focus creators count as if a day newer, so they win among similar ages without beating something truly fresher
  const focus = loadTuning().focusCreators;
  const channelOf = (e: QueueEntry) => (e.jobId ? runtimeStore().get<{ channel?: string }>("legacy-jobs", e.jobId)?.value.channel : undefined);
  const rank = (entries: QueueEntry[]) => {
    const channel = channelOf(entries[0]!);
    return newest(entries) + (channel && focus.includes(creatorName(channel)) ? 86_400_000 : 0);
  };
  fresh.sort(([, a], [, b]) => rank(b) - rank(a));
  const groupOf = (entries: QueueEntry[]) => (shortTestGroupOf(entries[0]!) === "narrated" ? ("narrated" as const) : ("plain" as const));
  const lastPost = queue()
    .list()
    .filter((e) => e.status === "scheduled" && e.slotAt && e.jobId)
    .sort((a, b) => b.slotAt! - a.slotAt!)[0];
  const ordered = alternateByTest(fresh, ([, entries]) => groupOf(entries), lastPost && shortTestGroupOf(lastPost) === "narrated" ? "narrated" : "plain");
  for (const [group, entries] of ordered) {
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
      const options = { group, automatic: true, audienceTz: audienceTz(effective().postingAudience), now };
      const r = approve(ready, "", undefined, options);
      scheduled = r.scheduled;
      if (r.scheduled.length) return r.entries;
      // the schedule is full: a newer original takes the slot of an older one
      const bumped = bumpOlderPost(ready, newest(entries), now);
      if (!bumped) return all;
      const second = approve(bumped, "", undefined, options);
      scheduled = second.scheduled;
      return second.scheduled.length ? second.entries : all;
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
