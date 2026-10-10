import {
  requestProjectRender,
  renderStatus,
  cancelProjectRender,
} from "@/server/studio/render";
import { errorResponse } from "@/server/http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Context) {
  try {
    return Response.json(renderStatus((await ctx.params).id));
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(req: Request, ctx: Context) {
  try {
    const { revision, preset } = await req.json();
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw Error("Invalid project revision");
    return Response.json(
      await requestProjectRender((await ctx.params).id, revision, preset),
      { status: 202 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function DELETE(req: Request, ctx: Context) {
  try {
    const { workId } = await req.json();
    if (typeof workId !== "string") throw Error("Missing work identity");
    await cancelProjectRender((await ctx.params).id, workId);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
