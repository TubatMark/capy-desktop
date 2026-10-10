import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  importAsset,
  listAssets,
  relinkAsset,
  retryAsset,
} from "@/server/studio/assets";
import { errorResponse } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await listAssets());
}
export async function POST(req: Request) {
  let temporary: string | undefined;
  try {
    if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (
        !(file instanceof File) ||
        file.size === 0 ||
        file.size > 512 * 1024 ** 2
      )
        throw Error(
          "Choose a file under 512 MB; use a local path for larger files",
        );
      const kind = String(form.get("kind"));
      temporary = await mkdtemp(path.join(os.tmpdir(), "capy-import-"));
      const filename = path.join(temporary, path.basename(file.name));
      await writeFile(filename, new Uint8Array(await file.arrayBuffer()));
      const id = form.get("relinkId");
      const asset = id
        ? await relinkAsset(String(id), filename)
        : await importAsset({
            path: filename,
            kind: kind as "video",
            name: file.name,
          });
      return Response.json(asset, { status: 201 });
    }
    return Response.json(await importAsset(await req.json()), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    if (typeof body.id === "string" && body.action === "retry")
      return Response.json(await retryAsset(body.id));
    if (typeof body.id !== "string" || typeof body.path !== "string")
      throw Error("Choose an asset and replacement path");
    return Response.json(await relinkAsset(body.id, body.path));
  } catch (error) {
    return errorResponse(error);
  }
}
