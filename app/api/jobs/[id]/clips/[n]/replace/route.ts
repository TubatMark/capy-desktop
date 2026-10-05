import { NextResponse } from "next/server";
import { jobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** POST { reason? } = swap this pick for a new moment that avoids the reason. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  try {
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
    return NextResponse.json(await jobs().replaceClip(id, Number(n), reason));
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
