import {
  getProject,
  saveProject,
  projectHistory,
} from "@/server/studio/projects";
import { errorResponse } from "@/server/http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Context) {
  const { id } = await ctx.params;
  const document = getProject(id);
  return document
    ? Response.json({ document, history: projectHistory(id) })
    : Response.json({ error: "Project not found" }, { status: 404 });
}
export async function PUT(req: Request, ctx: Context) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    if (body.document?.id !== id || !getProject(id))
      return Response.json({ error: "Project not found" }, { status: 404 });
    return Response.json(
      await saveProject(body.document, body.expectedRevision),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
