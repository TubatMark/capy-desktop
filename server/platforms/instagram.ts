import { openAsBlob, statSync } from "node:fs";
import { GRAPH } from "../oauth";
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
  if (r.uploaded && !r.deliveryPhase)
    throw new PlatformError(
      "Instagram delivery uncertain; check the destination before retrying",
      false,
    );
  let container = r.container;
  const uncertainPublish = r.deliveryPhase === "attempted";
  if (!container) {
    if (ctx.reconcileOnly)
      throw new DeliveryUnknownError(
        "Instagram has no recorded container to reconcile",
      );
    ctx.beforeMutation?.();
    ctx.checkpoint?.({ deliveryPhase: "session-create-intent" });
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
    container = remoteId(cb.id);
    const uploadUri =
      (cb.uri as string | undefined) ??
      `https://rupload.facebook.com/ig-api-upload/${GRAPH}/${container}`;
    ctx.checkpoint?.({ container, uploadUri, deliveryPhase: "session-known" });
    ctx.beforeMutation?.();
    ctx.checkpoint?.({ deliveryPhase: "transfer-intent" });
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
  }

  for (let i = 0; ; i++) {
    const s = await call(
      ctx.fetch,
      `${G}/${container}?fields=status_code,status&access_token=${encodeURIComponent(ctx.token)}`,
    );
    const b = await readJson(s);
    if (!s.ok) throw httpError(s, b);
    if (uncertainPublish) {
      ctx.observe?.({
        state: "delivery-unknown",
        visibility: "unknown",
        remoteStatus: String(b.status_code ?? "unknown"),
      });
      return {
        kind: "needs_action",
        note: "Instagram publication was attempted; check the destination. It will not be published again automatically.",
      };
    }
    if (b.status_code === "FINISHED") {
      ctx.checkpoint?.({ container, uploaded: "1", deliveryPhase: "prepared" });
      if (ctx.reconcileOnly) {
        ctx.observe?.({
          state: "uploaded",
          visibility: "unknown",
          remoteStatus: "FINISHED",
        });
        return {
          kind: "needs_action",
          note: "Instagram has prepared the media; publishing requires current checks",
        };
      }
      break;
    }
    if (b.status_code === "ERROR" || b.status_code === "EXPIRED")
      throw new PlatformError(
        `Instagram couldn't process the video: ${b.status ?? b.status_code}`,
        false,
      );
    if (ctx.singlePoll) {
      ctx.observe?.({
        state: "processing",
        visibility: "unknown",
        remoteStatus: String(b.status_code ?? "unknown"),
      });
      return {
        kind: "needs_action",
        note: "Instagram is processing the saved container",
      };
    }
    if (i >= 120)
      throw new PlatformError(
        "Instagram is taking too long to process the video",
        true,
      );
    await ctx.sleep(5_000);
  }

  ctx.beforeMutation?.();
  ctx.checkpoint?.({ deliveryPhase: "attempted" });
  const p = await call(
    ctx.fetch,
    `${G}/${ctx.igUserId}/media_publish`,
    form({ creation_id: container, access_token: ctx.token }),
  );
  const pb = await readJson(p);
  if (!p.ok) throw httpError(p, pb);
  const id = remoteId(pb.id);
  ctx.checkpoint?.({ mediaId: id, deliveryPhase: "acknowledged" });
  return finish(id, ctx);
}

/** Acknowledgement and permalink do not establish public visibility. */
async function finish(id: string, ctx: ClientCtx): Promise<PostOutcome> {
  try {
    const l = await ctx.fetch(
      `${G}/${id}?fields=permalink&access_token=${encodeURIComponent(ctx.token)}`,
    );
    const lb = l.ok ? await readJson(l) : {};
    ctx.observe?.({
      state: "needs-action",
      visibility: "unknown",
      publicationIds: [id],
      remoteStatus: l.ok ? "published-visibility-unverified" : "lookup-failed",
    });
    return {
      kind: "needs_action",
      id,
      url: lb.permalink as string | undefined,
      note: "Instagram acknowledged publication; public visibility has not been verified.",
    };
  } catch {
    ctx.observe?.({
      state: "delivery-unknown",
      visibility: "unknown",
      publicationIds: [id],
      remoteStatus: "lookup-failed",
    });
    return {
      kind: "needs_action",
      id,
      note: "Instagram acknowledged publication but its current status could not be checked.",
    };
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
