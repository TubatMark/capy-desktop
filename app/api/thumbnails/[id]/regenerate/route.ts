import {
  regenerateThumbnail,
  resolveRegeneration,
} from "@/server/thumbnail-studio";
import { errorResponse } from "@/server/http";
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params,
      { expectedRevision, kind, requestId } = await req.json();
    return Response.json(
      await regenerateThumbnail(id, expectedRevision, kind, requestId),
      { status: 202 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function GET(req: Request) {
  try {
    return Response.json(
      await resolveRegeneration(
        new URL(req.url).searchParams.get("requestId") ?? "",
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
