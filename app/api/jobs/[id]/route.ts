import { NextResponse } from "next/server";
import { jobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const m = jobs();
  await m.init();
  const job = m.get(id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(job);
}

/** PATCH { settings } changes the look, caption style, layout or captions/hook flags of every clip. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  try {
    const m = jobs();
    await m.init();
    return NextResponse.json(await m.updateSettings(id, body.settings ?? {}));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
