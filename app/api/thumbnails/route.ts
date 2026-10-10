import {
  generateThumbnails,
  listThumbnailFrames,
  thumbnailDependencies,
  resolveThumbnailSource,
} from "@/server/thumbnails";
import { getThumbnail, listStudioThumbnails } from "@/server/thumbnail-studio";
import {
  presentThumbnail,
  presentFrame,
} from "@/server/thumbnail-presentation";
import { checksum } from "@/server/studio/assets";
import { errorResponse } from "@/server/http";
import type { JobState } from "@/lib/types";
import type { ThumbnailSourceRef } from "@/lib/thumbnails";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const url = new URL(req.url),
      deps = thumbnailDependencies();
    let source: ThumbnailSourceRef | undefined;
    if (url.searchParams.has("source")) {
      source = JSON.parse(url.searchParams.get("source")!);
      await resolveThumbnailSource(source!, deps);
    }
    if (url.searchParams.has("jobId")) {
      const jobId = url.searchParams.get("jobId")!,
        n = Number(url.searchParams.get("clipN"));
      const row = deps.store.get<JobState>("legacy-jobs", jobId),
        clip = row?.value.clips.find((c) => c.n === n);
      if (!row || !clip?.render.file || clip.render.status !== "done")
        throw Error("Finished clip unavailable");
      source = {
        kind: "legacy",
        jobId,
        clipN: n,
        revision: row.revision,
        renderChecksum: await checksum(clip.render.file),
      };
    }
    return Response.json({
      source,
      designs: listStudioThumbnails(source, deps).map(presentThumbnail),
      frames: source ? listThumbnailFrames(source, deps).map(presentFrame) : [],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(req: Request) {
  try {
    return Response.json(await generateThumbnails(await req.json()), {
      status: 202,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
