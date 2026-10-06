import { NextResponse } from "next/server";
import { z } from "zod";
import { stories } from "@/server/stories";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

const Body = z.object({ notes: z.array(z.string().trim().min(1).max(300)).max(10).optional(), page: z.number().int().min(0).max(11).optional(), voice: z.string().trim().min(1).max(80).optional() });

/** POST = approve | rewrite { notes } | redraw { page } | render { voice } | queue */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const b = parsed.data;
  const m = stories();
  await m.init();
  try {
    switch (action) {
      case "approve":
        return NextResponse.json(await m.approveScript(id));
      case "rewrite":
        return NextResponse.json(await m.rewrite(id, b.notes ?? []));
      case "redraw":
        if (b.page === undefined) return NextResponse.json({ error: "Which page?" }, { status: 400 });
        return NextResponse.json(await m.redrawPage(id, b.page));
      case "render":
        return NextResponse.json(await m.render(id, b.voice));
      case "queue":
        return NextResponse.json({ platforms: await m.sendToQueue(id) });
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
