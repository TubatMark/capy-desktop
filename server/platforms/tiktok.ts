import { openAsBlob, statSync } from "node:fs";
import {
  call,
  PlatformError,
  DeliveryUnknownError,
  remoteId,
  readJson,
  type ClientCtx,
  type PostJob,
  type PostOutcome,
} from "./types";

const T = "https://open.tiktokapis.com/v2";
const MB = 1024 * 1024;

/** TikTok answers 200 with error.code != "ok" for most failures; map both shapes. */
async function api(
  ctx: ClientCtx,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const r = await call(ctx.fetch, `${T}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  const b = await readJson(r);
  const err = b.error as { code?: string; message?: string } | undefined;
  if (r.ok && (!err || err.code === "ok"))
    return (b.data as Record<string, unknown>) ?? {};
  const code = err?.code ?? `http_${r.status}`;
  const auth =
    /access_token_invalid|scope_not_authorized|token_not_authorized/.test(
      code,
    ) || r.status === 401;
  const retryable =
    r.status === 429 ||
    r.status >= 500 ||
    /rate_limit|internal_error/.test(code);
  const limited = r.status === 429 || /rate_limit/.test(code);
  throw new PlatformError(
    `TikTok: ${err?.message || code}`,
    retryable,
    auth,
    auth
      ? "auth"
      : limited
        ? "rate-limit"
        : retryable
          ? "transient"
          : "permanent",
  );
}

/** Chunking rules: under 64 MB in one go, else 10 MB chunks with the remainder in the last one. */
export function chunking(size: number) {
  if (size <= 64 * MB) return { chunk_size: size, total_chunk_count: 1 };
  const chunk = 10 * MB;
  return { chunk_size: chunk, total_chunk_count: Math.floor(size / chunk) };
}

/** Send a clip to the TikTok inbox (works before the app audit) or post it directly. */
export async function postTikTok(
  job: PostJob,
  ctx: ClientCtx & { mode: "inbox" | "direct"; username?: string },
): Promise<PostOutcome> {
  // an earlier attempt already sent the file: only follow its status (never send it twice)
  const bound = job.deliveryOptions;
  if (
    bound &&
    (bound.mode !== ctx.mode ||
      (bound.mode !== "inbox" && bound.mode !== "direct"))
  )
    throw new PlatformError(
      "TikTok delivery mode differs from approval",
      false,
    );
  const resumed = job.resume?.publishId;
  if (ctx.reconcileOnly && !resumed)
    throw new DeliveryUnknownError("TikTok has no saved publish identifier");
  if (
    resumed &&
    job.resume?.uploadUrl &&
    job.resume.uploaded !== "1" &&
    !ctx.reconcileOnly
  ) {
    const status = await api(ctx, "/post/publish/status/fetch/", {
      publish_id: resumed,
    });
    if (status.status === "PROCESSING_UPLOAD") {
      const offset = Number(status.uploaded_bytes);
      await uploadChunks(job, ctx, job.resume.uploadUrl, offset);
    }
  }
  if (
    resumed &&
    bound?.mode === "direct" &&
    !["PUBLIC_TO_EVERYONE", "SELF_ONLY"].includes(job.resume?.privacy ?? "")
  )
    throw new PlatformError(
      "TikTok resumed privacy is uncertain or outside approval",
      false,
    );
  if (resumed && bound?.mode === "inbox" && job.resume?.privacy)
    throw new PlatformError(
      "TikTok resumed action differs from assisted inbox approval",
      false,
    );
  const { publishId, privacy } = resumed
    ? { publishId: resumed, privacy: job.resume?.privacy ?? "" }
    : await send(job, ctx);
  return follow(publishId, privacy, ctx);
}

async function send(
  job: PostJob,
  ctx: ClientCtx & { mode: "inbox" | "direct" },
): Promise<{ publishId: string; privacy: string }> {
  const size = statSync(job.file).size;
  const c = chunking(size);
  const source_info = { source: "FILE_UPLOAD", video_size: size, ...c };
  let privacy = "";
  let init: Record<string, unknown>;
  if (ctx.mode === "direct") {
    const info = await api(ctx, "/post/publish/creator_info/query/", {});
    const opts = (info.privacy_level_options as string[] | undefined) ?? [];
    // Creator capabilities cannot silently strengthen or substitute the approved visibility policy.
    privacy = opts.includes("PUBLIC_TO_EVERYONE")
      ? "PUBLIC_TO_EVERYONE"
      : opts.includes("SELF_ONLY")
        ? "SELF_ONLY"
        : "";
    if (!privacy)
      throw new PlatformError(
        "TikTok offers no privacy allowed by the approved policy",
        false,
      );
    ctx.beforeMutation?.();
    ctx.checkpoint?.({ deliveryPhase: "session-create-intent" });
    init = await api(ctx, "/post/publish/video/init/", {
      post_info: {
        title: job.text.caption ?? "",
        privacy_level: privacy,
        video_cover_timestamp_ms: Math.round((job.thumbAt ?? 1) * 1000),
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
      },
      source_info,
    });
  } else {
    ctx.beforeMutation?.();
    ctx.checkpoint?.({ deliveryPhase: "session-create-intent" });
    init = await api(ctx, "/post/publish/inbox/video/init/", { source_info });
  }
  const publishId = remoteId(init.publish_id);
  const uploadUrl = typeof init.upload_url === "string" ? init.upload_url : "";
  if (!uploadUrl.startsWith("https://"))
    throw new DeliveryUnknownError("TikTok did not return a valid upload URL");
  ctx.checkpoint?.({
    publishId,
    uploadUrl,
    privacy,
    deliveryPhase: "session-known",
  });
  await uploadChunks(job, ctx, uploadUrl, 0);
  return { publishId, privacy };
}
async function uploadChunks(
  job: PostJob,
  ctx: ClientCtx,
  uploadUrl: string,
  offset: number,
) {
  const size = statSync(job.file).size,
    c = chunking(size);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > size ||
    (offset !== size && offset % c.chunk_size !== 0)
  )
    throw new DeliveryUnknownError(
      "TikTok upload progress does not match a recoverable chunk boundary",
    );

  const blob = await openAsBlob(job.file);
  for (
    let i = Math.floor(offset / c.chunk_size);
    i < c.total_chunk_count;
    i++
  ) {
    const a = i * c.chunk_size;
    const b = i === c.total_chunk_count - 1 ? size : a + c.chunk_size;
    ctx.beforeMutation?.();
    ctx.checkpoint?.({
      deliveryPhase: "transfer-intent",
      uploadOffset: String(a),
    });
    const r = await call(ctx.fetch, uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(b - a),
        "Content-Range": `bytes ${a}-${b - 1}/${size}`,
      },
      body: blob.slice(a, b),
    });
    if (!r.ok)
      throw new PlatformError(
        `TikTok upload failed (HTTP ${r.status})`,
        r.status === 429 || r.status >= 500,
      );
  }
  ctx.checkpoint?.({ uploaded: "1", deliveryPhase: "acknowledged" });
}

async function follow(
  publishId: string,
  privacy: string,
  ctx: ClientCtx & { username?: string },
): Promise<PostOutcome> {
  for (let i = 0; i < 120; i++) {
    const s = await api(ctx, "/post/publish/status/fetch/", {
      publish_id: publishId,
    });
    const st = s.status as string;
    if (st === "FAILED")
      throw new PlatformError(
        `TikTok couldn't post it: ${s.fail_reason ?? "unknown reason"}`,
        false,
      );
    if (st === "SEND_TO_USER_INBOX") {
      ctx.observe?.({
        state: "needs-action",
        visibility: "inbox",
        remoteStatus: st,
      });
      return {
        kind: "needs_action",
        id: publishId,
        note: "Sent to your TikTok inbox. Open TikTok, tap the notification and post it (the caption is below to copy).",
      };
    }
    if (st === "PUBLISH_COMPLETE") {
      const ids = Array.isArray(s.publicaly_available_post_id)
        ? s.publicaly_available_post_id.filter(
            (id): id is string =>
              typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id),
          )
        : [];
      const postId = ids[0];
      ctx.observe?.({
        state: postId ? "public" : "needs-action",
        visibility: postId
          ? "public"
          : privacy === "SELF_ONLY"
            ? "private"
            : "unknown",
        publicationIds: ids,
        remoteStatus: st,
      });
      return postId
        ? {
            kind: "posted",
            id: postId,
            url: ctx.username
              ? `https://www.tiktok.com/@${ctx.username}/video/${postId}`
              : undefined,
          }
        : {
            kind: "needs_action",
            id: publishId,
            note: "TikTok reports completion, but public visibility is not confirmed. Check the post in TikTok.",
          };
    }
    ctx.observe?.({
      state: "processing",
      visibility: "unknown",
      remoteStatus: st,
    });
    if (ctx.singlePoll)
      return {
        kind: "needs_action",
        id: publishId,
        note: "TikTok is processing the saved upload",
      };
    await ctx.sleep(5_000);
  }
  throw new PlatformError(
    "TikTok is taking too long to process the video",
    true,
  );
}

/** Who signed in (user.info.basic fields only; username would need user.info.profile). */
export async function tiktokAccount(
  ctx: ClientCtx,
): Promise<{ id: string; name: string; avatar?: string }> {
  const r = await call(
    ctx.fetch,
    `${T}/user/info/?fields=open_id,display_name,avatar_url`,
    { headers: { Authorization: `Bearer ${ctx.token}` } },
  );
  const b = await readJson(r);
  const u = ((b.data as { user?: Record<string, string> } | undefined)?.user ??
    {}) as Record<string, string>;
  if (!r.ok || !u.open_id)
    throw new PlatformError(
      `TikTok: ${(b.error as { message?: string } | undefined)?.message ?? `HTTP ${r.status}`}`,
      false,
      r.status === 401,
    );
  return {
    id: u.open_id,
    name: u.display_name ?? "TikTok",
    avatar: u.avatar_url,
  };
}
