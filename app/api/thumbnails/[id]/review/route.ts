import { approveThumbnail } from "@/server/thumbnail-studio";
import { errorResponse } from "@/server/http";
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params,
      { revision } = await req.json();
    return Response.json(await approveThumbnail(id, revision));
  } catch (error) {
    return errorResponse(error);
  }
}
