import { openAsBlob, statSync } from "node:fs";
import { GRAPH } from "../oauth";
import {
  call,
  httpError,
  PlatformError,
  readJson,
  type ClientCtx,
  type PostJob,
  type PostOutcome,
} from "./types";

const G = `https://graph.facebook.com/${GRAPH}`;

const form = (params: Record<string, string | undefined>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(
    Object.entries(params).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  ).toString(),
});

/** Post a Reel from a local file: resumable container → upload → wait → publish. Resumes from job.resume. */
export async function postInstagram(
  job: PostJob,
  ctx: ClientCtx & { igUserId: string },
): Promise<PostOutcome> {
  const r = job.resume ?? {};
  if (r.mediaId) return finish(r.mediaId, ctx);
  if (r.uploaded && r.deliveryPhase !== "prepared")
    throw new PlatformError(
      "Instagram delivery uncertain; check the destination before retrying",
      false,
    );
  let container = r.uploaded ? r.container : undefined;
  if (!container) {
    const size = statSync(job.file).size;
    const c = await call(
      ctx.fetch,
      `${G}/${ctx.igUserId}/media`,
      form({
        media_type: "REELS",
        upload_type: "resumable",
        caption: job.text.caption ?? "",
        share_to_feed: "true",
        thumb_offset:
          job.thumbAt !== undefined
            ? String(Math.round(job.thumbAt * 1000))
            : undefined,
        access_token: ctx.token,
      }),
    );
    const cb = await readJson(c);
    if (!c.ok) throw httpError(c, cb);
    container = String(cb.id);
    const up = await call(
      ctx.fetch,
      (cb.uri as string | undefined) ??
        `https://rupload.facebook.com/ig-api-upload/${GRAPH}/${container}`,
      {
        method: "POST",
        headers: {
          Authorization: `OAuth ${ctx.token}`,
          offset: "0",
          file_size: String(size),
        },
        body: await openAsBlob(job.file),
      },
    );
    if (!up.ok) throw httpError(up, await readJson(up));
    ctx.checkpoint?.({ container, uploaded: "1", deliveryPhase: "prepared" });
    ctx.log(`uploaded to container ${container}`);
  }

  for (let i = 0; ; i++) {
    const s = await call(
      ctx.fetch,
      `${G}/${container}?fields=status_code,status&access_token=${encodeURIComponent(ctx.token)}`,
    );
    const b = await readJson(s);
    if (!s.ok) throw httpError(s, b);
    if (b.status_code === "FINISHED") break;
    if (b.status_code === "ERROR" || b.status_code === "EXPIRED")
      throw new PlatformError(
        `Instagram couldn't process the video: ${b.status ?? b.status_code}`,
        false,
      );
    if (i >= 120)
      throw new PlatformError(
        "Instagram is taking too long to process the video",
        true,
      );
    await ctx.sleep(5_000);
  }

  ctx.checkpoint?.({ deliveryPhase: "attempted" });
  const p = await call(
    ctx.fetch,
    `${G}/${ctx.igUserId}/media_publish`,
    form({ creation_id: container, access_token: ctx.token }),
  );
  const pb = await readJson(p);
  if (!p.ok) throw httpError(p, pb);
  const id = String(pb.id);
  ctx.checkpoint?.({ mediaId: id, deliveryPhase: "acknowledged" });
  return finish(id, ctx);
}

/** Published: look up the link; failing that it is still posted. */
async function finish(id: string, ctx: ClientCtx): Promise<PostOutcome> {
  try {
    const l = await ctx.fetch(
      `${G}/${id}?fields=permalink&access_token=${encodeURIComponent(ctx.token)}`,
    );
    const lb = l.ok ? await readJson(l) : {};
    return { kind: "posted", id, url: lb.permalink as string | undefined };
  } catch {
    return { kind: "posted", id };
  }
}

/** Instagram business accounts linked to the user's Facebook Pages. */
export async function instagramAccounts(
  ctx: ClientCtx,
): Promise<{ id: string; name: string; avatar?: string }[]> {
  const r = await call(
    ctx.fetch,
    `${G}/me/accounts?fields=name,instagram_business_account{id,username,profile_picture_url}&access_token=${encodeURIComponent(ctx.token)}`,
  );
  const b = await readJson(r);
  if (!r.ok) throw httpError(r, b);
  type PageRow = {
    name: string;
    instagram_business_account?: {
      id: string;
      username?: string;
      profile_picture_url?: string;
    };
  };
  return ((b.data as PageRow[] | undefined) ?? [])
    .filter((p) => p.instagram_business_account)
    .map((p) => ({
      id: p.instagram_business_account!.id,
      name: p.instagram_business_account!.username ?? p.name,
      avatar: p.instagram_business_account!.profile_picture_url,
    }));
}
