import type { QueueEntry } from "../lib/types";
import type { DeliveryRecord, DeliveryState } from "../lib/delivery";
import {
  createDelivery,
  readDelivery,
  updateDelivery,
  readDeliveryHandles,
  saveDeliveryHandles,
  deliveryForPackage,
  deliveryProjection,
} from "./delivery-store";
import { queue, reconcileMissed, recoverInterrupted } from "./queue";
import {
  eligibility,
  connectedAccountId,
  hashManifest,
} from "./publication-policy";
import { runtimeStore } from "./db/runtime";
import { assertWork, currentWork, fence } from "./worker/context";
import { scopedFetch } from "./worker/http";
import {
  admissionReasons,
  automationPublicationFiles,
} from "./automation-policy";
import { getAccessToken, loadAccounts, AuthError } from "./accounts";
import {
  capabilitiesForAccount,
  nextQuotaReset,
  destinationClientIdentity,
} from "./platform-capabilities";
import { effective } from "./settings";
import { audienceTz } from "../lib/post-time";
import { postYouTube } from "./platforms/youtube";
import { postInstagram } from "./platforms/instagram";
import { postTikTok } from "./platforms/tiktok";
import {
  PlatformError,
  DeliveryUnknownError,
  isTransportFailure,
  type ClientCtx,
  type RemoteObservation,
} from "./platforms/types";
class GateDenied extends Error {}
export interface DeliveryDependencies {
  fetch?: typeof fetch;
  token?: typeof getAccessToken;
}
function requireWorker(signal?: AbortSignal) {
  if (!currentWork()) throw Error("Delivery requires the durable worker");
  signal?.throwIfAborted();
  assertWork();
}
function entryFor(d: DeliveryRecord) {
  return queue()
    .list()
    .find(
      (e) =>
        e.key === d.queueKey &&
        e.publishPackage?.packageHash === d.package.packageHash,
    );
}
function paused() {
  return admissionReasons({ kind: "poster" }).length > 0;
}
function project(d: DeliveryRecord) {
  fence(() =>
    queue().mutate((all) =>
      all.map((e) =>
        e.key === d.queueKey &&
        !["rejected", "review"].includes(e.status) &&
        e.publishPackage?.packageHash === d.package.packageHash
          ? {
              ...e,
              delivery: deliveryProjection(d),
              status:
                d.state === "public"
                  ? "posted"
                  : d.state === "failed"
                    ? "failed"
                    : ["needs-action", "delivery-unknown"].includes(d.state)
                      ? "needs_action"
                      : "posting",
              nextTryAt: d.nextTryAt,
              authBlocked: d.retryClass === "auth",
              error: d.reason,
              updatedAt: Date.now(),
              progress: undefined,
              result: {
                id: d.publicationIds[0],
                url:
                  d.publicationIds[0] && d.package.platform === "youtube"
                    ? `https://studio.youtube.com/video/${d.publicationIds[0]}/edit`
                    : undefined,
                note: d.reason,
              },
            }
          : e,
      ),
    ),
  );
}
/** Every mutation re-enters the shared eligibility authority and exact destination fence. */
function gate(
  d: DeliveryRecord,
  files: NonNullable<QueueEntry["publicationFiles"]>,
  clientIdentity: string,
  signal: AbortSignal,
  mutationKind?: "thumbnail",
) {
  requireWorker(signal);
  if (paused())
    throw new GateDenied(
      "Posting is paused; saved remote evidence is retained",
    );
  const e = entryFor(d);
  if (!e)
    throw new GateDenied(
      "Publication package changed or was removed; review required",
    );
  const pendingThumbnail =
    mutationKind === "thumbnail" &&
    d.visibility === "public" &&
    ["pending", "unknown"].includes(d.thumbnail.status) &&
    e.status === "posted";
  if (
    !pendingThumbnail &&
    (!["scheduled", "posting", "failed"].includes(e.status) ||
      e.slotAt === undefined)
  )
    throw new GateDenied(
      "Publication authorization is no longer executable; review required",
    );
  if (
    d.package.deliveryOptions.mode === "scheduled" &&
    d.package.deliveryOptions.publishAt <= Date.now() + 60000
  )
    throw new GateDenied(
      "The approved remote publication time has expired; only status checks are allowed",
    );
  const earliest =
    (e.slotAt ?? 0) - (e.remoteSchedule?.uploadAheadMinutes ?? 0) * 60000;
  if (Date.now() < earliest)
    throw new GateDenied("The approved upload window has not started");
  const a = loadAccounts()[d.package.platform];
  if (
    destinationClientIdentity(d.package.platform, a) !== clientIdentity ||
    connectedAccountId(d.package.platform) !== d.package.accountId
  )
    throw new GateDenied("The selected publishing account changed");
  const checked = eligibility(e, automationPublicationFiles(e, files));
  if (!checked.allowed) throw new GateDenied(checked.reasons.join("; "));
  if (
    d.package.platform === "tiktok" &&
    d.package.deliveryOptions.mode !== "inbox"
  )
    throw new GateDenied(
      "TikTok direct publishing eligibility is not established; create an assisted inbox approval",
    );
}
export async function deliverPackage(
  packageId: string,
  signal: AbortSignal,
  deps: DeliveryDependencies = {},
): Promise<DeliveryState> {
  requireWorker(signal);
  if (paused()) throw new GateDenied("Posting is paused");
  const found = queue()
    .list()
    .find((e) => e.publishPackage?.id === packageId);
  if (!found) throw Error("Publication package not found");
  const existing = deliveryForPackage(found.publishPackage!.packageHash);
  if (existing) {
    if (existing.nextTryAt && existing.nextTryAt > Date.now())
      return existing.state;
    return executeDelivery(existing, signal, false, deps);
  }
  const { resolvePublicationFiles } = await import("./poster");
  const resolved = await resolvePublicationFiles(found);
  if (typeof resolved === "string")
    throw new GateDenied("Approved media is missing or changed");
  let d = fence(() =>
    runtimeStore().transaction(() => {
      const current = queue()
        .list()
        .find((e) => e.key === found.key);
      if (
        !current ||
        hashManifest(current.publishPackage) !==
          hashManifest(found.publishPackage)
      )
        throw new GateDenied(
          "Publication package changed while resolving media",
        );
      const record = createDelivery({ ...current, publicationFiles: resolved });
      queue().mutate((all) =>
        all.map((e) =>
          e.key === found.key
            ? { ...e, delivery: deliveryProjection(record) }
            : e,
        ),
      );
      return record;
    }),
  );
  if (d.state === "public") return d.state;
  return executeDelivery(d, signal, false, deps);
}
export async function reconcileDelivery(
  deliveryId: string,
  deps: DeliveryDependencies = {},
): Promise<DeliveryState> {
  requireWorker();
  const d = readDelivery(deliveryId);
  if (!d) throw Error("Delivery not found");
  return executeDelivery(d, currentWork()!.signal, true, deps);
}
async function executeDelivery(
  initial: DeliveryRecord,
  signal: AbortSignal,
  reconcileOnly: boolean,
  deps: DeliveryDependencies,
): Promise<DeliveryState> {
  let d = initial;
  if (paused()) return d.state;
  // Adopt a saved one-ahead acknowledgement before changing its exact intent revision.
  let handles = readDeliveryHandles(d);
  d = readDelivery(d.id)!;
  const e = entryFor(d),
    platform = d.package.platform,
    a = loadAccounts()[platform],
    clientIdentity = destinationClientIdentity(platform, a);
  if (
    connectedAccountId(platform) !== d.package.accountId ||
    (handles.destinationClientIdentity &&
      handles.destinationClientIdentity !== clientIdentity)
  ) {
    d = updateDelivery(d.id, (x) => ({
      ...x,
      state: "needs-action",
      retryClass: "auth",
      reason: "Reconnect the original publishing destination",
      nextTryAt: undefined,
    }));
    project(d);
    return d.state;
  }
  if (
    !handles.destinationClientIdentity &&
    d.phase === "not-started" &&
    !e?.progress
  ) {
    d = saveDeliveryHandles(d, { destinationClientIdentity: clientIdentity });
    handles = { ...handles, destinationClientIdentity: clientIdentity };
    d = updateDelivery(d.id, (x) => ({ ...x, phase: "destination-pinned" }));
  }
  if (!handles.deliveryPhase && e?.progress) {
    handles = { ...e.progress };
    d = saveDeliveryHandles(d, handles);
  }
  if (
    !["not-started", "destination-pinned", "initialization-rejected"].includes(
      d.phase,
    ) &&
    !handles.session &&
    !handles.videoId &&
    !handles.container &&
    !handles.publishId
  ) {
    d = updateDelivery(d.id, (x) => ({
      ...x,
      state: "delivery-unknown",
      reason:
        "An earlier remote request has no recoverable identifier; check the destination before any new upload",
      nextTryAt: undefined,
    }));
    project(d);
    return d.state;
  }
  const { resolvePublicationFiles } = await import("./poster");
  const resolved = e ? await resolvePublicationFiles(e) : "missing";
  const files = typeof resolved === "object" ? resolved : { file: "" };
  // Status queries can still establish prior outcomes after local media/review changes.
  const mutationsAllowed = (kind?: "thumbnail") => {
    if (handles.destinationClientIdentity !== clientIdentity)
      throw new GateDenied(
        "Original delivery client identity is unavailable; status checks only",
      );
    gate(readDelivery(d.id)!, files, clientIdentity, signal, kind);
  };
  try {
    const token = await (deps.token ?? getAccessToken)(
      platform,
      deps.fetch ?? scopedFetch,
      d.package.accountId,
    );
    requireWorker(signal);
    if (
      destinationClientIdentity(platform, loadAccounts()[platform]) !==
        clientIdentity ||
      connectedAccountId(platform) !== d.package.accountId
    )
      throw new GateDenied(
        "Publishing destination changed during token acquisition",
      );
    // Status reads remain valid after revocation/deadline; each actual mutation enters the gate.
    let observed = false;
    const observe = (o: RemoteObservation) => {
      const at = Date.now();
      observed = true;
      const remoteStatus =
        o.remoteStatus && /^[a-zA-Z_-]{1,80}$/.test(o.remoteStatus)
          ? o.remoteStatus
          : undefined;
      d = updateDelivery(d.id, (x) => ({
        ...x,
        state: o.state,
        visibility: o.visibility,
        remoteStatus,
        observedAt: at,
        firstPublicAt:
          o.visibility === "public" ? (x.firstPublicAt ?? at) : x.firstPublicAt,
        publishedAt: o.publishedAt ?? x.publishedAt,
        publicationIds: [
          ...new Set([...x.publicationIds, ...(o.publicationIds ?? [])]),
        ],
        phase: o.state === "public" ? "publication-observed" : x.phase,
        reason: undefined,
        retryClass: undefined,
        nextTryAt: [
          "processing",
          "uploading",
          "uploaded",
          "scheduled",
        ].includes(o.state)
          ? at + 60000
          : undefined,
      }));
    };
    const checkpoint = (p: Record<string, string>) => {
      requireWorker(signal);
      d = readDelivery(d.id)!;
      d = saveDeliveryHandles(d, p);
      handles = { ...handles, ...p };
      const phase: DeliveryRecord["phase"] =
        p.deliveryPhase === "session-create-intent"
          ? "session-create-intent"
          : p.deliveryPhase === "session-known"
            ? "session-known"
            : p.deliveryPhase === "transfer-intent"
              ? "transfer-intent"
              : p.deliveryPhase === "prepared" ||
                  p.deliveryPhase === "acknowledged"
                ? "media-accepted"
                : p.deliveryPhase === "attempted"
                  ? platform === "instagram"
                    ? "publish-intent"
                    : "transfer-intent"
                  : d.phase;
      d = updateDelivery(d.id, (x) => ({
        ...x,
        phase: p.thumbnailStatus && x.state === "public" ? x.phase : phase,
        state:
          p.thumbnailStatus && x.state === "public"
            ? "public"
            : phase === "media-accepted"
              ? "uploaded"
              : "uploading",
        thumbnail: p.thumbnailStatus
          ? {
              status:
                p.thumbnailStatus as DeliveryRecord["thumbnail"]["status"],
              checksum: handles.thumbnailChecksum,
              attemptedAt: handles.thumbnailAttemptedAt
                ? Number(handles.thumbnailAttemptedAt)
                : x.thumbnail.attemptedAt,
              observedAt: Date.now(),
              httpStatus: handles.thumbnailHttpStatus
                ? Number(handles.thumbnailHttpStatus)
                : undefined,
            }
          : x.thumbnail,
      }));
    };
    const fetcher: typeof fetch = async (input, init) => {
      requireWorker(signal);
      if (paused()) throw new GateDenied("Posting is paused");
      const method = init?.method ?? "GET",
        url = String(input),
        headers = new Headers(init?.headers);
      const query =
        method === "GET" ||
        url.includes("/status/fetch/") ||
        url.includes("/creator_info/query/") ||
        (method === "PUT" && headers.get("content-length") === "0");
      if (!query) {
        if (reconcileOnly)
          throw new GateDenied(
            "Reconciliation cannot perform a new remote mutation",
          );
        mutationsAllowed(
          url.startsWith(
            "https://www.googleapis.com/upload/youtube/v3/thumbnails/set?",
          )
            ? "thumbnail"
            : undefined,
        );
      }
      const response = await (deps.fetch ?? scopedFetch)(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(30000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      requireWorker(signal);
      return response;
    };
    const ctx: ClientCtx = {
      token,
      fetch: fetcher,
      sleep: async () => {},
      log: () => {},
      checkpoint,
      observe,
      beforeMutation: mutationsAllowed,
      singlePoll: true,
      reconcileOnly,
    };
    const job = {
      file: files.file,
      thumbFile: files.thumbFile,
      thumbnailPending:
        d.thumbnail.status === "pending" &&
        handles.destinationClientIdentity === clientIdentity &&
        !handles.thumbnailStatus,
      text: d.package.text,
      thumbAt: e?.thumbAt,
      madeForKids: e?.madeForKids,
      deliveryOptions: d.package.deliveryOptions,
      resume: handles,
    };
    const result =
      platform === "youtube"
        ? await postYouTube(job, ctx)
        : platform === "instagram"
          ? await postInstagram(job, { ...ctx, igUserId: d.package.accountId })
          : await postTikTok(job, {
              ...ctx,
              mode:
                d.package.deliveryOptions.mode === "direct"
                  ? "direct"
                  : "inbox",
            });
    if (!observed)
      d = updateDelivery(d.id, (x) => ({
        ...x,
        state: "needs-action",
        reason:
          "Remote operation finished without verified visibility; check the destination",
        nextTryAt: undefined,
      }));
    else if (result.kind === "needs_action")
      d = updateDelivery(d.id, (x) => ({
        ...x,
        reason: result.note.slice(0, 500),
      }));
  } catch (error) {
    // Lease loss must not let an obsolete executor claim an error or completion.
    requireWorker(signal);
    d = readDelivery(d.id)!;
    // A failed file/DB checkpoint may be one step ahead. Recover it before any new revision.
    handles = readDeliveryHandles(d);
    d = readDelivery(d.id)!;
    const known = !!(
      handles.session ||
      handles.videoId ||
      handles.container ||
      handles.publishId
    );
    const uncertain =
      error instanceof DeliveryUnknownError ||
      isTransportFailure(error) ||
      d.phase === "publish-intent";
    const gateError =
      error instanceof GateDenied
        ? error
        : error instanceof Error && error.cause instanceof GateDenied
          ? error.cause
          : undefined;
    const blocked = !!gateError,
      auth =
        error instanceof AuthError ||
        (error instanceof PlatformError && error.auth);
    const cls = auth
      ? "auth"
      : error instanceof PlatformError
        ? error.failureClass
        : "transient";
    // An explicit quota/rate rejection before a session exists is safe to retry after its window.
    // Transport failures and server failures never establish that an initialization was rejected.
    if (
      !known &&
      d.phase === "session-create-intent" &&
      error instanceof PlatformError &&
      !isTransportFailure(error) &&
      ["quota", "rate-limit"].includes(cls)
    ) {
      d = saveDeliveryHandles(d, { deliveryPhase: "initialization-rejected" });
      d = updateDelivery(d.id, (x) => ({
        ...x,
        phase: "initialization-rejected",
      }));
    }
    const retry =
      !blocked &&
      !auth &&
      !(error instanceof DeliveryUnknownError) &&
      ((uncertain && known) ||
        (error instanceof PlatformError && error.retryable));
    const next = retry
      ? cls === "quota"
        ? nextQuotaReset(Date.now())
        : Date.now() +
          Math.max(
            error instanceof PlatformError ? (error.retryAfterMs ?? 0) : 0,
            Math.min(3600000, 30000 * 2 ** Math.min(d.attempts, 7)),
          )
      : undefined;
    d = updateDelivery(d.id, (x) => ({
      ...x,
      state:
        blocked || auth
          ? "needs-action"
          : uncertain
            ? "delivery-unknown"
            : "failed",
      attempts: x.attempts + 1,
      retryClass: cls,
      nextTryAt: next,
      reason: blocked
        ? gateError!.message.slice(0, 500)
        : auth
          ? "Reconnect the original publishing destination"
          : uncertain
            ? "Remote acceptance is uncertain; only the saved operation will be queried"
            : cls === "quota"
              ? "Platform daily quota exhausted; waiting for the next quota window"
              : cls === "rate-limit"
                ? "Platform rate limit reached; retry is deferred"
                : "Delivery could not be completed; saved remote evidence is retained",
    }));
  }
  project(d);
  return d.state;
}
/** A bounded worker pass, preserving all completed and unresolved delivery records. */
export async function tickDeliveries(signal: AbortSignal): Promise<void> {
  requireWorker(signal);
  if (paused()) return;
  fence(() =>
    queue().mutate((all) => {
      const protectedKeys = new Set(
        all
          .filter(
            (e) =>
              e.remoteSchedule ||
              (e.publishPackage &&
                deliveryForPackage(e.publishPackage.packageHash)),
          )
          .map((e) => e.key),
      );
      const revised = reconcileMissed(
        recoverInterrupted(
          all.filter((e) => !protectedKeys.has(e.key)),
          new Date(),
        ),
        audienceTz(effective().postingAudience),
        new Date(),
      );
      return all.map((e) =>
        protectedKeys.has(e.key)
          ? e
          : (revised.find((r) => r.key === e.key) ?? e),
      );
    }),
  );
  const entries = queue().list();
  for (const e of entries) {
    if (paused()) break;
    requireWorker(signal);
    const pkg = e.publishPackage;
    if (!pkg) continue;
    const d = deliveryForPackage(pkg.packageHash);
    if (d) {
      if (["rejected", "review"].includes(e.status)) continue;
      // Delivery is authoritative: repair a projection lost after its separate durable commit.
      project(d);
      if (
        (d.state === "public" && d.thumbnail.status !== "pending") ||
        (!d.nextTryAt &&
          ["needs-action", "delivery-unknown", "failed"].includes(d.state)) ||
        (d.nextTryAt && d.nextTryAt > Date.now())
      )
        continue;
      if (["delivery-unknown", "needs-action"].includes(d.state))
        await reconcileDelivery(d.id);
      else
        await executeDelivery(
          d,
          signal,
          ["processing", "scheduled"].includes(d.state),
          {},
        );
    } else if (
      (e.status === "scheduled" &&
        e.slotAt !== undefined &&
        e.slotAt - (e.remoteSchedule?.uploadAheadMinutes ?? 0) * 60000 <=
          Date.now()) ||
      (e.status === "failed" &&
        e.nextTryAt !== undefined &&
        e.nextTryAt <= Date.now())
    ) {
      try {
        await deliverPackage(pkg.id, signal);
      } catch (error) {
        requireWorker(signal);
        fence(() =>
          queue().mutate((all) =>
            all.map((x) =>
              x.key === e.key
                ? {
                    ...x,
                    status: "needs_action",
                    error:
                      error instanceof GateDenied
                        ? error.message
                        : "Delivery preparation failed; review the saved package",
                    nextTryAt: undefined,
                  }
                : x,
            ),
          ),
        );
      }
    }
  }
}
