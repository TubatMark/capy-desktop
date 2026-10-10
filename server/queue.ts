import {
  deliveryForPackage,
  deliveryProjection,
  updateDelivery,
} from "./delivery-store";
import { queueGroup } from "../lib/queue-source";
import { SIMILARITY_STORE, type ClipSimilarity } from "../lib/similarity";
import { legacyState, mutateLegacy, runtimeStore } from "./db/runtime";
import { decide, eligibility } from "./publication-policy";
import { allocateSlot, fmtIn } from "../lib/post-time";
import type {
  ContentReview,
  Platform,
  PostText,
  QueueEntry,
  QueueSummary,
  SeoReport,
} from "../lib/types";
import { postTextFor, type Publish } from "./platforms/text";
import { canResumeDelivery, type PostOutcome } from "./platforms/types";
import { queueThumbnailFields } from "./queue-thumbnails";

/**
 * The posting queue: one entry per clip × platform in <CAPY_DATA_DIR>/queue.json.
 * Rendered clips enter as "review"; only an approval gives them a slot. Every transition is a pure
 * function over the entry list (tested directly); queue().mutate applies one and saves.
 */

export interface ClipInfo {
  publicationFiles?: { file: string; thumbFile?: string };
  jobId: string;
  n: number;
  start: number;
  end: number;
  clipTitle: string;
  videoTitle?: string;
  videoUrl?: string;
  thumbUrl?: string;
  thumbAt?: number;
  publish?: Publish;
  hook?: string;
  aiReview?: ContentReview;
  /** A kids' story: YouTube marks it "made for kids". */
  madeForKids?: boolean;
  /** Identity of this cut when start/end can't tell (a story's render); default fingerprint(start, end). */
  fp?: string;
  link?: string;
  seo?: SeoReport;
}

const MIN = 60_000;
const LATE_MS = 2 * 60 * MIN;
const BACKOFF_MIN = [2, 10, 30];

export const keyOf = (jobId: string, n: number, p: Platform) =>
  `${jobId}:${n}:${p}`;

/** Identifies one cut of a clip; the same number can later hold different footage (re-pick, replace, trim). */
export const fingerprint = (start: number, end: number) =>
  `${Math.round(start * 10)}-${Math.round(end * 10)}`;

export function note(e: QueueEntry, msg: string, now: Date): QueueEntry {
  return {
    ...e,
    history: [...e.history, { t: now.getTime(), msg }].slice(-50),
    updatedAt: now.getTime(),
  };
}

export function patch(
  entries: QueueEntry[],
  key: string,
  fn: (e: QueueEntry) => QueueEntry,
): QueueEntry[] {
  return entries.map((e) => (e.key === key ? fn(e) : e));
}

/** A clip finished rendering: add review entries, or refresh the media of ones still waiting to post. */
export function upsertForRender(
  entries: QueueEntry[],
  c: ClipInfo,
  platforms: Platform[],
  now: Date,
): QueueEntry[] {
  const out = [...entries];
  const publish = c.publish ?? {
    ytTitle: c.clipTitle,
    description: "",
    hashtags: [],
  };
  const fp = c.fp ?? fingerprint(c.start, c.end);
  const fresh = (key: string, p: Platform): QueueEntry =>
    note(
      {
        key,
        jobId: c.jobId,
        n: c.n,
        platform: p,
        fp,
        status: "review",
        ...media,
        text: postTextFor(p, publish, c.hook),
        attempts: 0,
        history: [],
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      },
      "Rendered, waiting for your OK",
      now,
    );
  const media = {
    publicationFiles: c.publicationFiles,
    videoUrl: c.videoUrl,
    thumbUrl: c.thumbUrl,
    thumbAt: c.thumbAt,
    clipTitle: c.clipTitle,
    videoTitle: c.videoTitle,
    aiReview: c.aiReview,
    ...(c.madeForKids ? { madeForKids: true } : {}),
    ...(c.link ? { link: c.link } : {}),
    ...(c.seo ? { seo: c.seo } : {}),
  };
  for (const p of platforms) {
    const key = keyOf(c.jobId, c.n, p);
    const i = out.findIndex((e) => e.key === key);
    if (i < 0) {
      out.push(fresh(key, p));
      continue;
    }
    const e = out[i]!;
    if (e.status === "posting" || deliveryMutationReason(e)) continue; // mid-upload: leave it be
    if (e.fp && e.fp !== fp) {
      // different footage under the same clip number: it was never approved, so it gets its own review
      const archived: QueueEntry =
        e.status === "posted"
          ? e
          : { ...e, status: "rejected", slotAt: undefined };
      out[i] = note(
        { ...archived, key: `${key}~${e.fp}` },
        "Replaced by a different cut of this clip",
        now,
      );
      out.push(fresh(key, p));
      continue;
    }
    if (e.status === "posted" || e.status === "rejected") continue;
    // Every completed re-render needs a new decision, including captions/audio-only changes.
    out[i] = note(
      {
        ...e,
        ...media,
        fp,
        status: "review",
        error: undefined,
        slotAt: undefined,
        nextTryAt: undefined,
        publicationDecision: undefined,
        publishPackage: undefined,
        progress: undefined,
      },
      "Re-rendered, waiting for a new decision",
      now,
    );
  }
  return out;
}

/**
 * Slot-allocator input: scheduled/posting entries, plus anything that reached the platform in the last 24h
 * (posted, or needs_action with an id: TikTok inbox, YouTube forced private).
 */
export function taken(
  entries: QueueEntry[],
  now: Date,
  except?: (e: QueueEntry) => boolean,
) {
  const out = (e: QueueEntry) =>
    e.status === "posted" || (e.status === "needs_action" && !!e.result?.id);
  return entries
    .filter((e) => !except?.(e))
    .filter(
      (e) =>
        ((e.status === "scheduled" || e.status === "posting") &&
          e.slotAt !== undefined) ||
        (out(e) && now.getTime() - (e.slotAt ?? e.updatedAt) < 24 * 60 * MIN),
    )
    .map((e) => ({ platform: e.platform, at: e.slotAt ?? e.updatedAt }));
}

/** Approve one clip (n) or every clip of a video waiting for review; each clip gets one shared slot. */
export function approve(
  entries: QueueEntry[],
  jobId: string,
  n: number | undefined,
  o: {
    platforms?: Platform[];
    audienceTz: string;
    now: Date;
    override?: boolean;
    group?: string;
    /** Auto-scheduling: no human decision is recorded; the automatic policy authorizes it instead. */
    automatic?: boolean;
  },
): { entries: QueueEntry[]; scheduled: QueueEntry[] } {
  let out = [...entries];
  const groups = [
    ...new Set(
      out
        .filter(
          (e) =>
            e.status === "review" &&
            (o.group
              ? queueGroup(e) === o.group
              : !e.source &&
                e.jobId === jobId &&
                (n === undefined || e.n === n)),
        )
        .map(queueGroup),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const scheduled: QueueEntry[] = [];
  for (const group of groups) {
    const mine = out.filter(
      (e) => queueGroup(e) === group && e.status === "review",
    );
    const selected = mine.filter(
      (e) => !o.platforms || o.platforms.includes(e.platform),
    );
    const chosen = selected
      .map((e) => decide(e, !!o.override, o.now))
      .map((e) =>
        o.automatic
          ? { ...e, publicationDecision: undefined, autoScheduledAt: o.now.getTime() }
          : e,
      )
      .filter((e) => eligibility(e).allowed);
    for (const e of mine)
      if (!selected.includes(e))
        out = patch(out, e.key, (x) =>
          note({ ...x, status: "rejected" }, "Not chosen at approval", o.now),
        );
    if (!chosen.length) continue;
    const slot = allocateSlot(
      taken(out, o.now),
      chosen.map((e) => e.platform),
      o.audienceTz,
      o.now,
    );
    for (const e of chosen) {
      out = patch(out, e.key, (x) =>
        slot
          ? note(
              {
                ...x,
                publishPackage: e.publishPackage,
                publicationDecision: e.publicationDecision,
                autoScheduledAt: e.autoScheduledAt,
                status: "scheduled",
                slotAt: slot.getTime(),
                attempts: 0,
                error: undefined,
              },
              `${o.automatic ? "Scheduled automatically (every check passed)" : o.override ? "Explicit human override approved" : "Approved"} for ${fmtIn(slot, o.audienceTz)}`,
              o.now,
            )
          : note(x, "No free slot in the next 14 days", o.now),
      );
      if (slot) scheduled.push(out.find((x) => x.key === e.key)!);
    }
  }
  return { entries: out, scheduled };
}

export const reject = (entries: QueueEntry[], key: string, now: Date) =>
  patch(
    entries,
    key,
    (e) => (
      assertDeliveryMutable(e),
      note(
        {
          ...e,
          status: "rejected",
          slotAt: undefined,
          nextTryAt: undefined,
          publicationDecision: undefined,
        },
        "Rejected",
        now,
      )
    ),
  );

export const remove = (entries: QueueEntry[], key: string) =>
  entries.filter((e) => {
    if (e.key === key) assertDeliveryMutable(e);
    return e.key !== key;
  });

export const editText = (
  entries: QueueEntry[],
  key: string,
  text: PostText,
  now: Date,
) =>
  patch(
    entries,
    key,
    (e) => (
      assertDeliveryMutable(e),
      {
        ...e,
        remoteSchedule: undefined,
        text: { ...e.text, ...text },
        status: "review",
        slotAt: undefined,
        nextTryAt: undefined,
        publicationDecision: undefined,
        progress: undefined,
        updatedAt: now.getTime(),
      }
    ),
  );

const gated = (e: QueueEntry, next: () => QueueEntry, now: Date) => {
  assertDeliveryMutable(e);
  if (e.remoteSchedule)
    throw Error(
      "Use explicit remote schedule approval to change its bound publication time",
    );
  const result = eligibility(e);
  return result.allowed
    ? next()
    : note(
        {
          ...e,
          status: "review",
          slotAt: undefined,
          nextTryAt: undefined,
          error: result.reasons.join("; "),
        },
        result.reasons.join("; "),
        now,
      );
};

export const move = (
  entries: QueueEntry[],
  key: string,
  slotAt: number,
  now: Date,
  tz: string,
) =>
  patch(entries, key, (e) =>
    gated(
      e,
      () =>
        note(
          { ...e, status: "scheduled", slotAt, nextTryAt: undefined },
          `Moved to ${fmtIn(new Date(slotAt), tz)}`,
          now,
        ),
      now,
    ),
  );

export const postNow = (entries: QueueEntry[], key: string, now: Date) =>
  patch(entries, key, (e) =>
    gated(
      e,
      () =>
        note(
          {
            ...e,
            status: "scheduled",
            slotAt: now.getTime(),
            nextTryAt: undefined,
          },
          "Post now",
          now,
        ),
      now,
    ),
  );

export const retry = (entries: QueueEntry[], key: string, now: Date) =>
  patch(entries, key, (e) =>
    gated(
      e,
      () =>
        note(
          {
            ...e,
            status: "scheduled",
            slotAt: now.getTime(),
            attempts: 0,
            nextTryAt: undefined,
            error: undefined,
            authBlocked: false,
          },
          "Retry",
          now,
        ),
      now,
    ),
  );

/** Slots that passed while capy wasn't running: under 2h late still post; later ones move to a new slot. */
export function reconcileMissed(
  entries: QueueEntry[],
  audienceTz: string,
  now: Date,
): QueueEntry[] {
  let out = [...entries];
  const late = out.filter(
    (e) =>
      e.status === "scheduled" &&
      !e.remoteSchedule &&
      !deliveryMutationReason(e) &&
      e.slotAt !== undefined &&
      now.getTime() - e.slotAt > LATE_MS,
  );
  const groups = new Map<string, QueueEntry[]>();
  for (const e of late)
    groups.set(queueGroup(e), [...(groups.get(queueGroup(e)) ?? []), e]);
  for (const group of groups.values()) {
    const keys = new Set(group.map((e) => e.key));
    const slot = allocateSlot(
      taken(out, now, (e) => keys.has(e.key)),
      group.map((e) => e.platform),
      audienceTz,
      now,
    );
    for (const e of group) {
      if (!eligibility(e).allowed) {
        out = patch(out, e.key, (x) => gated(x, () => x, now));
        continue;
      }
      out = patch(out, e.key, (x) =>
        slot
          ? note(
              { ...x, slotAt: slot.getTime() },
              `Missed ${fmtIn(new Date(x.slotAt!), audienceTz)} (the computer was asleep or capy was closed), moved to ${fmtIn(slot, audienceTz)}`,
              now,
            )
          : note(
              { ...x, slotAt: now.getTime() },
              "Missed its slot and no free slot is left, posting now",
              now,
            ),
      );
    }
  }
  return out;
}

/** Interrupted delivery is resumed only when a durable remote acknowledgement exists. */
export function recoverInterrupted(
  entries: QueueEntry[],
  now: Date,
): QueueEntry[] {
  return entries.map((e) =>
    e.status !== "posting"
      ? e
      : canResumeDelivery(e.platform, e.progress)
        ? gated(
            e,
            () =>
              note(
                { ...e, status: "scheduled", slotAt: now.getTime() },
                "Interrupted; resuming acknowledged delivery",
                now,
              ),
            now,
          )
        : note(
            {
              ...e,
              status: "needs_action",
              slotAt: undefined,
              nextTryAt: undefined,
              error:
                "Delivery uncertain. Check the destination before retrying.",
            },
            "Interrupted before remote acknowledgement; needs confirmation",
            now,
          ),
  );
}

export type PostResult =
  | { outcome: PostOutcome }
  | { error: { message: string; retryable: boolean; auth: boolean } };

export function markResult(
  entries: QueueEntry[],
  key: string,
  r: PostResult,
  now: Date,
): QueueEntry[] {
  return patch(entries, key, (e) => {
    if ("outcome" in r) {
      const { id, url, note: n } = r.outcome;
      const result = { id, url, note: n };
      return r.outcome.kind === "posted"
        ? note(
            {
              ...e,
              status: "posted",
              result,
              error: undefined,
              nextTryAt: undefined,
            },
            n ? `Posted. ${n}` : "Posted",
            now,
          )
        : note(
            {
              ...e,
              status: "needs_action",
              result,
              error: undefined,
              nextTryAt: undefined,
            },
            r.outcome.note,
            now,
          );
    }
    const { message, retryable, auth } = r.error;
    if (auth)
      return note(
        {
          ...e,
          status: "needs_action",
          authBlocked: true,
          error: message,
          nextTryAt: undefined,
        },
        message,
        now,
      );
    const attempts = e.attempts + 1;
    const wait = retryable ? BACKOFF_MIN[attempts - 1] : undefined;
    if (wait !== undefined && !eligibility(e).allowed)
      return gated(e, () => e, now);
    return note(
      {
        ...e,
        status: "failed",
        attempts,
        error: message,
        nextTryAt: wait !== undefined ? now.getTime() + wait * MIN : undefined,
      },
      wait !== undefined ? `${message} (retrying in ${wait} min)` : message,
      now,
    );
  });
}

/** An account was reconnected: its entries that were waiting on it go back on the schedule. */
export function reconnected(
  entries: QueueEntry[],
  platform: Platform,
  audienceTz: string,
  now: Date,
): QueueEntry[] {
  let out = [...entries];
  for (const e of out.filter((x) => x.platform === platform && x.authBlocked)) {
    if (!eligibility(e).allowed) {
      out = patch(out, e.key, (x) => gated(x, () => x, now));
      continue;
    }
    const keep = e.slotAt !== undefined && e.slotAt > now.getTime();
    const slot = keep
      ? new Date(e.slotAt!)
      : allocateSlot(
          taken(out, now, (x) => x.key === e.key),
          [platform],
          audienceTz,
          now,
        );
    out = patch(out, e.key, (x) =>
      note(
        {
          ...x,
          status: "scheduled",
          authBlocked: false,
          error: undefined,
          slotAt: (slot ?? now).getTime(),
        },
        "Account reconnected",
        now,
      ),
    );
  }
  return out;
}

export function summary(entries: QueueEntry[], now: Date): QueueSummary {
  const active = entries.filter(
    (e) => e.status === "scheduled" || e.status === "posting",
  );
  const next = active
    .filter((e) => e.slotAt !== undefined)
    .sort((a, b) => a.slotAt! - b.slotAt!)[0];
  void now;
  return {
    review: new Set(
      entries.filter((e) => e.status === "review").map((e) => queueGroup(e)),
    ).size,
    activeCount: active.length,
    ...(() => {
      const auto = entries
        .filter((e) => e.autoScheduledAt)
        .sort((a, b) => b.autoScheduledAt! - a.autoScheduledAt!)[0];
      return auto ? { lastAuto: { at: auto.autoScheduledAt!, title: auto.clipTitle } } : {};
    })(),
    nextPost: next
      ? {
          at: next.slotAt!,
          platforms: active
            .filter((e) => e.slotAt === next.slotAt)
            .map((e) => e.platform),
        }
      : undefined,
  };
}

// ---------- store ----------

declare global {
  // eslint-disable-next-line no-var
  var __capyQueue:
    { file: string; mtime: number; entries: QueueEntry[] } | null | undefined;
}

export function resetQueueCache() {
  globalThis.__capyQueue = null;
}

const emptyQueue = (): QueueEntry[] => [];
const validQueue = (value: unknown) => Array.isArray(value);
function load(): QueueEntry[] {
  return legacyState("queue", emptyQueue, validQueue);
}

/** The queue store. `mutate` is synchronous, so two callers can never interleave a read-modify-write. */
export function queue() {
  return {
    list: () => load(),
    mutate(fn: (e: QueueEntry[]) => QueueEntry[]): QueueEntry[] {
      return mutateLegacy("queue", emptyQueue, validQueue, (all) => {
        const next = fn(all);
        // Revoke pre-intent delivery retries in the same transaction as the local decision.
        for (const old of all) {
          const after = next.find((e) => e.key === old.key);
          if (
            old.publishPackage &&
            (!after ||
              after.status === "rejected" ||
              after.status === "review") &&
            !deliveryMutationReason(old)
          ) {
            const d = deliveryForPackage(old.publishPackage.packageHash);
            if (
              d &&
              (d.nextTryAt !== undefined ||
                d.reason !== "Publication authorization revoked")
            )
              updateDelivery(d.id, (x) => ({
                ...x,
                state: "needs-action",
                nextTryAt: undefined,
                retryClass: undefined,
                reason: "Publication authorization revoked",
              }));
          }
        }
        return next;
      });
    },
  };
}

/** A local edit cannot revoke or repeat an already-started remote operation. */
export function deliveryMutationReason(e: QueueEntry, store = runtimeStore()): string | undefined {
  const d = e.publishPackage
    ? deliveryForPackage(e.publishPackage.packageHash, store)
    : undefined;
  if (
    d &&
    ((d.phase !== "not-started" &&
      d.phase !== "destination-pinned" &&
      d.phase !== "initialization-rejected") ||
      (d.checkpoint > 0 &&
        d.phase !== "destination-pinned" &&
        d.phase !== "initialization-rejected") ||
      d.state === "public")
  )
    return "A remote delivery has already started. Check its status or manage it on the destination; local edits cannot change or repeat it.";
}
/** Explicit public fields only: private resume handles and filesystem locations never leave the server. */
export function publicQueueEntry(e: QueueEntry): QueueEntry {
  const d = e.publishPackage
    ? deliveryForPackage(e.publishPackage.packageHash)
    : undefined;
  const designed = queueThumbnailFields(e);
  return {
    ...designed,
    // show what will be uploaded: the attached design, keeping the raw frame alongside
    ...(designed.thumbnailDesignUrl ? { frameThumbUrl: e.thumbUrl } : {}),
    key: e.key,
    jobId: e.jobId,
    n: e.n,
    source: e.source,
    platform: e.platform,
    status: e.status,
    clipTitle: e.clipTitle,
    text: e.text,
    attempts: e.attempts,
    history: e.history,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    aiReview: e.aiReview,
    similarity: runtimeStore().get<ClipSimilarity>(
      SIMILARITY_STORE,
      queueGroup(e),
    )?.value,
    seo: e.seo,
    fp: e.fp,
    madeForKids: e.madeForKids,
    link: e.link,
    videoTitle: e.videoTitle,
    videoUrl: e.videoUrl,
    thumbUrl: designed.thumbnailDesignUrl ?? e.thumbUrl,
    thumbAt: e.thumbAt,
    slotAt: e.slotAt,
    autoScheduledAt: e.autoScheduledAt,
    nextTryAt: e.nextTryAt,
    authBlocked: e.authBlocked,
    result: e.result,
    error: e.error,
    publishPackage: e.publishPackage,
    publicationDecision: e.publicationDecision,
    remoteSchedule: e.remoteSchedule,
    delivery: d ? deliveryProjection(d) : undefined,
    deliveryCanRetry: d ? !deliveryMutationReason(e) : undefined,
  };
}

function assertDeliveryMutable(e: QueueEntry) {
  const reason = deliveryMutationReason(e);
  if (reason) throw Error(reason);
}
