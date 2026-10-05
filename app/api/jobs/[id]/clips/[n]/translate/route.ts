import { NextResponse } from "next/server";
import { jobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** POST = retry translating this clip's captions to English. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await ctx.params;
  try {
    return NextResponse.json(await jobs().translateClip(id, Number(n)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
