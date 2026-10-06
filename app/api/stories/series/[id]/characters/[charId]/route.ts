import { NextResponse } from "next/server";
import { stories } from "@/server/stories";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

/** POST = draw this character again. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; charId: string }> }) {
  const { id, charId } = await ctx.params;
  await stories().init();
  try {
    return NextResponse.json(await stories().redrawCharacter(id, charId));
  } catch (e) {
    return errorResponse(e);
  }
}
