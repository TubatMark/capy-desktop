import { NextResponse } from "next/server";
import { jobs } from "@/server/jobs";
import { FORBIDDEN, getAccess } from "@/server/access";

export const dynamic = "force-dynamic";

/** Render all selected clips (or the `ns` given). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await getAccess(req);
  if (!access.can.render) return NextResponse.json(FORBIDDEN, { status: 403 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await jobs().render(id, Array.isArray(body.ns) ? body.ns.map(Number) : undefined));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
