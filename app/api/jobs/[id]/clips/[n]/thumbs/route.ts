import { NextResponse } from "next/server";
import { jobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** POST = grab candidate thumbnail frames for this clip. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await ctx.params;
  try {
    return NextResponse.json(await jobs().generateThumbs(id, Number(n)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/** PUT { at } = use the frame `at` seconds into the clip as its thumbnail. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await jobs().chooseThumb(id, Number(n), Number(body.at)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
