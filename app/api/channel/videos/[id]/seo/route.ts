import { NextResponse } from "next/server";
import { loadSnapshot } from "@/server/channel";
import { appAi, suggestForVideo } from "@/server/seo";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

/** POST = a search-tuned rewrite of one of the channel's videos, next to its current text (nothing changes yet). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const v = (await loadSnapshot())?.videos.find((x) => x.id === id);
  if (!v) return NextResponse.json({ error: "Video not found. Refresh the channel." }, { status: 404 });
  try {
    return NextResponse.json(await suggestForVideo(v, appAi()));
  } catch (e) {
    return errorResponse(e);
  }
}
