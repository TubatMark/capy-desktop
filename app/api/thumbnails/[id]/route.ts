import {
  getThumbnail,
  saveThumbnail,
  thumbnailHistory,
  listStudioThumbnails,
} from "@/server/thumbnail-studio";
import {
  listThumbnailFrames,
  thumbnailDependencies,
} from "@/server/thumbnails";
import {
  presentThumbnail,
  presentFrame,
} from "@/server/thumbnail-presentation";
import { errorResponse } from "@/server/http";
import type { QueueEntry } from "@/lib/types";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, ctx: Context) {
  try {
    const { id } = await ctx.params,
      deps = thumbnailDependencies(),
      doc = getThumbnail(id, undefined, deps);
    listStudioThumbnails(doc.sourceIdentity, deps);
    const packages = (
      deps.store.get<QueueEntry[]>("legacy-state", "queue")?.value ?? []
    )
      .filter(
        (e) =>
          e.publishPackage &&
          e.publishPackage.artifact.checksum ===
            doc.sourceIdentity.renderChecksum &&
          !["posting", "posted", "needs_action"].includes(e.status),
      )
      .map((e) => ({
        id: e.publishPackage!.id,
        label: `${e.clipTitle ?? "Video"} · ${e.platform} · ${e.status}`,
      }));
    return Response.json({
      document: presentThumbnail(getThumbnail(id, undefined, deps)),
      designs: listStudioThumbnails(doc.sourceIdentity, deps).map(
        presentThumbnail,
      ),
      frames: listThumbnailFrames(doc.sourceIdentity, deps).map(presentFrame),
      history: thumbnailHistory(id, deps).map(presentThumbnail),
      packages,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PUT(req: Request, ctx: Context) {
  try {
    const { id } = await ctx.params,
      { document, expectedRevision, restoredFromRevision } = await req.json();
    if (document?.id !== id) throw Error("Thumbnail ID mismatch");
    return Response.json(
      presentThumbnail(
        await saveThumbnail(
          document,
          expectedRevision,
          thumbnailDependencies(),
          { restoredFromRevision },
        ),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
