import { createHash } from "node:crypto";
import { openAsBlob, statSync } from "node:fs";
import {
  call,
  httpError,
  PlatformError,
  DeliveryUnknownError,
  remoteId,
  readJson,
  type ClientCtx,
  type PostJob,
  type PostOutcome,
} from "./types";
const API = "https://www.googleapis.com";
const CHUNK = 8 * 1024 * 1024;
/** Session and intent are durable before any bytes. A resumed transfer always queries first. */
export async function postYouTube(
  job: PostJob,
  ctx: ClientCtx,
): Promise<PostOutcome> {
  const auth = { Authorization: `Bearer ${ctx.token}` };
  const id = job.resume?.videoId
    ? remoteId(job.resume.videoId)
    : await upload(job, ctx, auth);
  if (!id)
    return {
      kind: "needs_action",
      note: "Upload is incomplete; resume the saved session after current checks pass",
    };
  await thumbnail(id, job, ctx, auth);
  return waitProcessed(id, job, ctx, auth);
}
async function upload(
  job: PostJob,
  ctx: ClientCtx,
  auth: Record<string, string>,
): Promise<string | undefined> {
  const size =
    job.resume?.session && job.resume.uploadSize
      ? Number(job.resume.uploadSize)
      : statSync(job.file).size;
  let session = job.resume?.session,
    offset = 0;
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new PlatformError("Video file is empty or invalid", false);
  if (session) {
    const status = await call(ctx.fetch, session, {
      method: "PUT",
      headers: {
        ...auth,
        "Content-Length": "0",
        "Content-Range": `bytes */${size}`,
      },
    });
    if (status.status === 308) {
      offset = acceptedOffset(status, size);
    } else if (status.ok) {
      const video = await readJson(status);
      const id = remoteId(video.id);
      ctx.checkpoint?.({ videoId: id, deliveryPhase: "acknowledged" });
      return id;
    } else if (status.status === 404 || status.status === 410)
      throw new DeliveryUnknownError(
        "Saved upload session expired; prior acceptance cannot be ruled out",
      );
    else throw httpError(status, await readJson(status));
  } else {
    if (ctx.reconcileOnly)
      throw new DeliveryUnknownError(
        "No saved upload session is available to reconcile",
      );
    ctx.beforeMutation?.();
    ctx.checkpoint?.({ deliveryPhase: "session-create-intent" });
    const options = job.deliveryOptions as { publishAt?: number } | undefined;
    const publishAt = options?.publishAt;
    if (publishAt !== undefined && publishAt <= Date.now() + 60000)
      throw new PlatformError(
        "Remote publish time must still be more than one minute in the future",
        false,
      );
    const init = await call(
      ctx.fetch,
      `${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
      {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(size),
        },
        body: JSON.stringify({
          snippet: {
            title: job.text.title ?? "",
            description: job.text.description ?? "",
            tags: job.text.tags ?? [],
            categoryId: "22",
          },
          status: {
            privacyStatus: publishAt !== undefined ? "private" : "public",
            ...(publishAt !== undefined
              ? { publishAt: new Date(publishAt).toISOString() }
              : {}),
            selfDeclaredMadeForKids: !!job.madeForKids,
          },
        }),
      },
    );
    if (!init.ok) throw httpError(init, await readJson(init));
    session = init.headers.get("location") ?? undefined;
    if (!session || !/^https:\/\//.test(session))
      throw new DeliveryUnknownError(
        "YouTube did not return a valid upload session",
      );
    ctx.checkpoint?.({
      session,
      uploadSize: String(size),
      uploadOffset: "0",
      deliveryPhase: "session-known",
    });
  }
  if (ctx.reconcileOnly) {
    ctx.observe?.({
      state: "uploading",
      visibility: "unknown",
      remoteStatus: "incomplete",
    });
    return;
  }
  const blob = await openAsBlob(job.file);
  while (offset < size) {
    const end = Math.min(size, offset + CHUNK);
    ctx.beforeMutation?.();
    if (
      job.deliveryOptions?.mode === "scheduled" &&
      job.deliveryOptions.publishAt <= Date.now() + 60000
    )
      throw new PlatformError(
        "The approved remote publication time has expired; status checks only",
        false,
      );
    ctx.checkpoint?.({
      deliveryPhase: "attempted",
      uploadOffset: String(offset),
    });
    const up = await call(ctx.fetch, session, {
      method: "PUT",
      headers: {
        ...auth,
        "Content-Type": "video/mp4",
        "Content-Length": String(end - offset),
        "Content-Range": `bytes ${offset}-${end - 1}/${size}`,
      },
      body: blob.slice(offset, end),
    });
    if (up.status === 308) {
      const next = acceptedOffset(up, size);
      if (next <= offset || next > end)
        throw new DeliveryUnknownError(
          "YouTube returned inconsistent upload progress",
        );
      offset = next;
      ctx.checkpoint?.({
        uploadOffset: String(offset),
        deliveryPhase: "session-known",
      });
      continue;
    }
    const video = await readJson(up);
    if (!up.ok) throw httpError(up, video);
    const id = remoteId(video.id);
    ctx.checkpoint?.({
      videoId: id,
      uploadOffset: String(size),
      deliveryPhase: "acknowledged",
    });
    return id;
  }
  throw new DeliveryUnknownError(
    "Upload accepted all bytes without a final resource; status reconciliation required",
  );
}
function acceptedOffset(response: Response, size: number): number {
  const range = response.headers.get("range");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const value = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(value) || value < 0 || value > size)
    throw new DeliveryUnknownError("Invalid remote upload range");
  return value;
}
async function thumbnail(
  id: string,
  job: PostJob,
  ctx: ClientCtx,
  auth: Record<string, string>,
) {
  if (
    !job.thumbFile ||
    ctx.reconcileOnly ||
    (job.resume?.videoId &&
      !job.resume.thumbnailStatus &&
      !job.thumbnailPending) ||
    ["accepted", "refused", "unknown"].includes(
      job.resume?.thumbnailStatus ?? "",
    )
  )
    return;
  const bytes = Buffer.from(
      await (await openAsBlob(job.thumbFile)).arrayBuffer(),
    ),
    checksum = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length > 50 * 1024 * 1024) {
    ctx.checkpoint?.({
      thumbnailStatus: "refused",
      thumbnailChecksum: checksum,
    });
    return;
  }
  ctx.beforeMutation?.("thumbnail");
  ctx.checkpoint?.({
    thumbnailStatus: "unknown",
    thumbnailChecksum: checksum,
    thumbnailAttemptedAt: String(Date.now()),
  });
  const result = await call(
    ctx.fetch,
    `${API}/upload/youtube/v3/thumbnails/set?videoId=${id}`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "image/jpeg" },
      body: new Blob([bytes]),
    },
  ).catch(() => null);
  ctx.checkpoint?.({
    videoId: id,
    deliveryPhase: "acknowledged",
    thumbnailStatus: result ? (result.ok ? "accepted" : "refused") : "unknown",
    thumbnailChecksum: checksum,
    ...(result ? { thumbnailHttpStatus: String(result.status) } : {}),
  });
}
async function waitProcessed(
  id: string,
  job: PostJob,
  ctx: ClientCtx,
  auth: Record<string, string>,
): Promise<PostOutcome> {
  const url = `https://studio.youtube.com/video/${id}/edit`;
  for (let i = 0; i < (ctx.singlePoll ? 1 : 60); i++) {
    const r = await call(
        ctx.fetch,
        `${API}/youtube/v3/videos?part=status,processingDetails&id=${id}`,
        { headers: auth },
      ),
      b = await readJson(r);
    if (!r.ok) throw httpError(r, b);
    const st = (
      b.items as { status?: Record<string, string> }[] | undefined
    )?.[0]?.status;
    if (!st)
      throw new DeliveryUnknownError(
        "The uploaded video could not be observed; no new upload will be started",
      );
    if (["failed", "rejected", "deleted"].includes(st.uploadStatus ?? ""))
      throw new PlatformError(
        `YouTube ${st.uploadStatus} the upload: ${st.rejectionReason ?? st.failureReason ?? "no reason given"}`,
        false,
      );
    const privacy = ["private", "unlisted", "public"].includes(
      st.privacyStatus ?? "",
    )
      ? (st.privacyStatus as "private" | "unlisted" | "public")
      : "unknown";
    if (st.uploadStatus === "processed") {
      if (privacy === "public") {
        ctx.observe?.({
          state: "public",
          visibility: "public",
          publicationIds: [id],
          remoteStatus: "processed",
        });
        return { kind: "posted", id, url: `https://youtube.com/shorts/${id}` };
      }
      const expected = (
        job.deliveryOptions as { publishAt?: number } | undefined
      )?.publishAt;
      if (
        expected !== undefined &&
        privacy === "private" &&
        Date.parse(st.publishAt ?? "") === expected &&
        expected > Date.now()
      ) {
        ctx.observe?.({
          state: "scheduled",
          visibility: "scheduled",
          publicationIds: [id],
          remoteStatus: "processed",
        });
        return {
          kind: "needs_action",
          id,
          url,
          note: "YouTube confirmed the requested schedule. Local pause does not cancel this remote schedule.",
        };
      }
      ctx.observe?.({
        state: "needs-action",
        visibility: privacy,
        publicationIds: [id],
        remoteStatus: "processed",
      });
      return {
        kind: "needs_action",
        id,
        url,
        note: `Uploaded with ${privacy} visibility. Check its settings in YouTube Studio; privacy does not establish app audit status.`,
      };
    }
    ctx.observe?.({
      state: "processing",
      visibility: privacy === "public" ? "unknown" : privacy,
      publicationIds: [id],
      remoteStatus: st.uploadStatus ?? "unknown",
    });
    if (!ctx.singlePoll) await ctx.sleep(10000);
  }
  return {
    kind: "needs_action",
    id,
    url,
    note: "Uploaded; YouTube is still processing it. Status will be checked again.",
  };
}
export async function youtubeAccount(
  ctx: ClientCtx,
): Promise<{ id: string; name: string; avatar?: string }> {
  const r = await call(
    ctx.fetch,
    `${API}/youtube/v3/channels?part=snippet&mine=true`,
    { headers: { Authorization: `Bearer ${ctx.token}` } },
  );
  const b = await readJson(r);
  if (!r.ok) throw httpError(r, b);
  const ch = (
    b.items as
      | {
          id: string;
          snippet: {
            title: string;
            thumbnails?: { default?: { url?: string } };
          };
        }[]
      | undefined
  )?.[0];
  if (!ch)
    throw new PlatformError(
      "This Google account has no YouTube channel",
      false,
    );
  return {
    id: ch.id,
    name: ch.snippet.title,
    avatar: ch.snippet.thumbnails?.default?.url,
  };
}
