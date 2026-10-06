import { NextResponse } from "next/server";
import { z } from "zod";
import { channelAccess, replaceVideo, updateVideoText } from "@/server/channel";
import { withHashtags } from "@/server/seo";
import { errorResponse } from "@/server/http";
import { getAccessToken } from "@/server/accounts";

export const dynamic = "force-dynamic";

const Body = z.strictObject({
  title: z.string().trim().min(1).max(100),
  description: z.string().max(5000),
  hashtags: z.array(z.string().trim().min(1).max(60)).max(15).default([]),
  tags: z.array(z.string().trim().min(1).max(100)).max(40),
});

/** PUT = change the video's title, description and tags on YouTube (only when the user clicks Update). */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid text" }, { status: 400 });
  if (!channelAccess().edit) return NextResponse.json({ error: "Reconnect YouTube in Settings → Accounts to let capy edit your videos." }, { status: 403 });
  const t = parsed.data;
  const tags: string[] = [];
  for (const x of t.tags) if ([...tags, x].join(",").length <= 500) tags.push(x);
  try {
    const v = await updateVideoText({ fetch, token: () => getAccessToken("youtube"), now: () => new Date() }, id, { title: t.title, description: withHashtags({ ...t, tags }), tags });
    await replaceVideo(v);
    return NextResponse.json(v);
  } catch (e) {
    return errorResponse(e);
  }
}
