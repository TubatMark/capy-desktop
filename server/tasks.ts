import { longVideoNeedsOwner } from "../lib/longform";
import type { LongVideo } from "../lib/longform";
import { queueGroup } from "../lib/queue-source";
import type { JobRecord } from "../lib/studio/types";
import type { Platform, QueueEntry, TodoTask } from "../lib/types";

/**
 * The user's To do, derived from what capy already knows (never stored, so it's always current). Only things that are
 * stuck until the owner steps in: skipped videos, clips waiting their turn and work capy is still retrying aren't tasks,
 * so an empty list is the normal state.
 */

const TONE_ORDER: Record<TodoTask["tone"], number> = { block: 0, action: 1, warn: 2 };

/** Past this a stopped background step isn't worth chasing: its video is too old to post. It stays in Monitor's log. */
export const WORK_TASK_MAX_AGE_MS = 3 * 86_400_000;

const WORK_TITLE: Record<string, string> = {
  media: "Couldn't make clips from a video",
  poster: "A post couldn't go out",
  thumbnail: "Couldn't make a thumbnail",
};
const NAMES: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

/** Background steps that stopped and won't carry on alone. The same problem on many videos is one task, not many. */
export function workTasks(work: JobRecord[], now: number): TodoTask[] {
  const out = new Map<string, TodoTask & { count: number }>();
  for (const j of work) {
    if (j.status !== "blocked" && j.status !== "needs_action") continue;
    // a long video keeps its own error, which videoTasks lists; too little footage is normal, capy tries again with new clips
    if (j.kind.startsWith("longform") || /usable footage/.test(j.error ?? "") || now - j.createdAt > WORK_TASK_MAX_AGE_MS) continue;
    const reason = j.error ?? "It stopped without saying why.";
    const id = `work:${j.kind}:${reason}`;
    const seen = out.get(id);
    if (seen) {
      seen.count++;
      seen.at = Math.max(seen.at, j.createdAt);
      seen.detail = `${reason} (${seen.count} times)`;
      continue;
    }
    const jobId = typeof j.payload.jobId === "string" ? j.payload.jobId : undefined;
    out.set(id, {
      id,
      kind: "work",
      tone: j.status === "needs_action" ? "action" : "warn",
      href: j.kind === "poster" ? "/short-form" : j.kind === "media" && jobId ? `/v/${jobId}` : "/automation",
      title: WORK_TITLE[j.kind] ?? "A background step stopped",
      detail: reason,
      at: j.createdAt,
      count: 1,
    });
  }
  return [...out.values()].map(({ count: _count, ...t }) => t);
}

/** Short form posts that failed or need a step only the owner can take, one task per clip. */
export function postTasks(queue: QueueEntry[]): TodoTask[] {
  const clips = new Map<string, QueueEntry[]>();
  for (const e of queue)
    if (e.status === "failed" || e.status === "needs_action") clips.set(queueGroup(e), [...(clips.get(queueGroup(e)) ?? []), e]);
  return [...clips].map(([group, es]) => {
    const first = es.find((e) => e.status === "failed");
    const shown = first ?? es[0]!;
    return {
      id: `post:${group}`,
      kind: "post",
      tone: first ? "block" : "action",
      href: "/short-form",
      title: first ? `“${shown.clipTitle}” couldn't post` : `“${shown.clipTitle}” needs a step from you`,
      detail: shown.result?.note ?? shown.error,
      at: Math.max(...es.map((e) => e.updatedAt)),
    };
  });
}

/** Long videos that stopped, or that the checks held back for the owner. */
export function videoTasks(videos: LongVideo[]): TodoTask[] {
  const out: TodoTask[] = [];
  for (const v of videos) {
    const need = longVideoNeedsOwner(v);
    if (need === "error")
      out.push({ id: `long:${v.id}`, kind: "video", tone: "block", href: "/longform", title: `“${v.title}” stopped`, detail: v.error, at: v.createdAt });
    else if (need === "warnings")
      out.push({ id: `long:${v.id}`, kind: "video", tone: "warn", href: "/longform", title: `Check “${v.title}”`, detail: v.check!.warnings.join(" "), at: v.createdAt });
  }
  return out;
}

/** Accounts capy has lost access to: nothing posts there until the owner signs in again. */
export function accountTasks(accounts: { platform: Platform; needsReconnect?: boolean }[], now: number): TodoTask[] {
  return accounts
    .filter((a) => a.needsReconnect)
    .map((a) => ({ id: `account:${a.platform}`, kind: "account", tone: "block", href: "/settings#accounts", title: `Sign in to ${NAMES[a.platform]} again`, detail: "capy can't post there until you do.", at: now }));
}

/** With automatic scheduling off, waiting clips really do wait for the owner. With it on they just wait for a free slot. */
function approvalTask(queue: QueueEntry[]): TodoTask[] {
  const waiting = queue.filter((e) => e.status === "review");
  const clips = new Set(waiting.map(queueGroup)).size;
  if (!clips) return [];
  return [
    {
      id: "approve",
      kind: "queue",
      tone: "action",
      href: "/short-form",
      title: `Approve or skip ${clips} waiting clip${clips === 1 ? "" : "s"}`,
      detail: "Automatic scheduling is off, so these wait for you.",
      at: Math.max(...waiting.map((e) => e.updatedAt)),
    },
  ];
}

export function todoTasks(input: {
  work: JobRecord[];
  queue: QueueEntry[];
  videos: LongVideo[];
  accounts: { platform: Platform; needsReconnect?: boolean }[];
  autoSchedule: boolean;
  now: number;
}): TodoTask[] {
  return [
    ...accountTasks(input.accounts, input.now),
    ...postTasks(input.queue),
    ...videoTasks(input.videos),
    ...workTasks(input.work, input.now),
    ...(input.autoSchedule ? [] : approvalTask(input.queue)),
  ].sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || b.at - a.at);
}
