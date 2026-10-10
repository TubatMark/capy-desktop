import { openAsBlob, statSync } from "node:fs";
import {
  call,
  httpError,
  PlatformError,
  readJson,
  type ClientCtx,
  type PostJob,
  type PostOutcome,
} from "./types";

const API = "https://www.googleapis.com";

/** Upload a Short with the YouTube Data API (resumable), try the custom thumbnail, wait for processing. */
export async function postYouTube(
  job: PostJob,
  ctx: ClientCtx,
): Promise<PostOutcome> {
  const auth = { Authorization: `Bearer ${ctx.token}` };
  // an earlier attempt already uploaded it: only wait for processing (never upload twice)
  const id = job.resume?.videoId ?? (await upload(job, ctx, auth));
  return waitProcessed(id, ctx, auth);
}

async function upload(
  job: PostJob,
  ctx: ClientCtx,
  auth: Record<string, string>,
): Promise<string> {
  const size = statSync(job.file).size;
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
          privacyStatus: "public",
          selfDeclaredMadeForKids: !!job.madeForKids,
        },
      }),
    },
  );
  if (!init.ok) throw httpError(init, await readJson(init));
  const session = init.headers.get("location");
  if (!session)
    throw new PlatformError("YouTube did not return an upload address", true);

  ctx.checkpoint?.({ deliveryPhase: "attempted" });
  const up = await call(ctx.fetch, session, {
    method: "PUT",
    headers: {
      ...auth,
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
    },
    body: await openAsBlob(job.file),
  });
  const video = await readJson(up);
  if (!up.ok) throw httpError(up, video);
  const id = String(video.id);
  ctx.checkpoint?.({ videoId: id, deliveryPhase: "acknowledged" });
  ctx.log(`uploaded video ${id}`);

  if (job.thumbFile) {
    // custom thumbnails need a verified channel; a refusal must not fail the post
    const t = await call(
      ctx.fetch,
      `${API}/upload/youtube/v3/thumbnails/set?videoId=${id}`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "image/jpeg" },
        body: await openAsBlob(job.thumbFile),
      },
    ).catch(() => null);
    if (t && !t.ok)
      ctx.log(
        `thumbnail not set (HTTP ${t.status}); custom thumbnails need a verified channel`,
      );
  }
  return id;
}

async function waitProcessed(
  id: string,
  ctx: ClientCtx,
  auth: Record<string, string>,
): Promise<PostOutcome> {
  for (let i = 0; i < 60; i++) {
    const r = await call(
      ctx.fetch,
      `${API}/youtube/v3/videos?part=status,processingDetails&id=${id}`,
      { headers: auth },
    );
    const b = await readJson(r);
    if (!r.ok) throw httpError(r, b);
    const st = ((
      b.items as { status?: Record<string, string> }[] | undefined
    )?.[0]?.status ?? {}) as Record<string, string>;
    if (st.uploadStatus === "failed" || st.uploadStatus === "rejected") {
      throw new PlatformError(
        `YouTube ${st.uploadStatus} the upload: ${st.rejectionReason ?? st.failureReason ?? "no reason given"}`,
        false,
      );
    }
    if (st.uploadStatus === "processed") {
      if (st.privacyStatus !== "public") {
        return {
          kind: "needs_action",
          id,
          url: `https://studio.youtube.com/video/${id}/edit`,
          note: "Uploaded as private (Google project not audited yet). Open YouTube Studio and set it to Public.",
        };
      }
      return { kind: "posted", id, url: `https://youtube.com/shorts/${id}` };
    }
    await ctx.sleep(10_000);
  }
  return {
    kind: "needs_action",
    id,
    url: `https://studio.youtube.com/video/${id}/edit`,
    note: "Uploaded; YouTube is still processing it. Check it in YouTube Studio.",
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
