import { thumbnailDependencies } from "@/server/thumbnails";
import { errorResponse } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const job = thumbnailDependencies().queue.get(id);
    if (!job || job.kind !== "thumbnail")
      throw Object.assign(Error("Thumbnail job not found"), { status: 404 });
    return Response.json({ id: job.id, status: job.status, error: job.error });
  } catch (error) {
    return errorResponse(error);
  }
}
