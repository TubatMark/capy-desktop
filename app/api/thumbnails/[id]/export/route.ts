import { readFile } from "node:fs/promises";
import { exportThumbnail, exportThumbnailZip } from "@/server/thumbnail-studio";
import { errorResponse } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params,
      q = new URL(req.url).searchParams;
    const output = await exportThumbnail(id, Number(q.get("revision")), {
      aspect: q.get("aspect") as "landscape",
      format: q.get("format") as "png",
      text: q.get("text") !== "false",
    });
    return new Response(new Uint8Array(await readFile(output.path)), {
      headers: {
        "Content-Type": output.filename.endsWith("png")
          ? "image/png"
          : "image/jpeg",
        "Content-Disposition": `attachment; filename="${output.filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(req: Request) {
  try {
    const { requests } = await req.json(),
      zip = await exportThumbnailZip(requests);
    return new Response(new Uint8Array(zip.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=capy-thumbnails.zip",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
