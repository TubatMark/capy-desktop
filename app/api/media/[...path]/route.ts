import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { safeMediaPath } from "@/server/paths";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json" };

/** Streams files from the output folder with HTTP Range support so <video> can seek. */
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await ctx.params;
  let abs: string;
  try {
    abs = safeMediaPath(parts.map(decodeURIComponent).join("/"));
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  const type = TYPES[ext] ?? "application/octet-stream";
  const range = req.headers.get("range");
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m?.[1] ? Number(m[1]) : 0;
    let end = m?.[2] ? Number(m[2]) : size - 1;
    if (!m?.[1] && m?.[2]) {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(fileStream(abs, { start, end }), { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(fileStream(abs), { status: 200, headers });
}

/**
 * fs read stream → web stream. Not `Readable.toWeb`: that adapter throws an uncaught
 * "Controller is already closed" when the client aborts mid-transfer, which <video> does
 * on every seek. This one stops on cancel and never touches a closed controller.
 */
function fileStream(abs: string, opts?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const file = createReadStream(abs, opts);
  let done = false;
  const finish = (fn: () => void) => {
    if (done) return;
    done = true;
    fn();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      file.on("data", (chunk: Buffer) => {
        if (done) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        // backpressure: wait for pull() when the consumer's queue is full
        if ((controller.desiredSize ?? 1) <= 0) file.pause();
      });
      file.on("end", () => finish(() => controller.close()));
      file.on("error", (e) => finish(() => controller.error(e)));
    },
    pull() {
      file.resume();
    },
    cancel() {
      finish(() => file.destroy());
    },
  });
}
