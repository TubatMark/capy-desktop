import { resolveRender } from "@/server/studio/render";
import { GET as streamMedia } from "@/app/api/media/[...path]/route";
import { OUTPUT_ROOT } from "@/server/paths";
import { errorResponse } from "@/server/http";
import path from "node:path";
export const dynamic = "force-dynamic";
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; renderId: string }> },
) {
  try {
    const { id, renderId } = await ctx.params;
    const checksum = new URL(req.url).searchParams.get("checksum");
    if (!checksum) throw Error("Missing render checksum");
    const artifact = await resolveRender(id, renderId, checksum);
    const response = await streamMedia(req, {
      params: Promise.resolve({
        path: path.relative(OUTPUT_ROOT, artifact.path).split(path.sep),
      }),
    });
    response.headers.set(
      "Content-Disposition",
      `attachment; filename="studio-revision-${artifact.revision}.mp4"`,
    );
    return response;
  } catch (e) {
    return errorResponse(e);
  }
}
