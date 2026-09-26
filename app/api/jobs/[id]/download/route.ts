import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { access } from "node:fs/promises";
import { ZipArchive } from "archiver";
import { jobs } from "@/server/jobs";
import { slug } from "@/src/util";

export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/:id/download?ns=1,3  → zip of rendered clips (all rendered when `ns` is omitted).
 * One folder per clip: video.mp4, thumbnail.jpg, title.txt, description.txt, hashtags.txt, plus a README.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const m = jobs();
  await m.init();
  const job = m.get(id);
  if (!job) return new Response("Not found", { status: 404 });
  const nsParam = new URL(req.url).searchParams.get("ns");
  const ns = nsParam ? new Set(nsParam.split(",").map(Number)) : null;
  const clips = job.clips.filter((c) => c.render.status === "done" && c.render.file && (!ns || ns.has(c.n)));
  if (clips.length === 0) return new Response("No rendered clips to download", { status: 400 });

  const zip = new ZipArchive({ zlib: { level: 1 } }); // video is already compressed; keep it fast
  const out = new PassThrough();
  zip.pipe(out);
  zip.on("error", (e: Error) => out.destroy(e));

  const lines: string[] = [`${job.title ?? job.url}`, job.url, "", "Clips:"];
  for (const c of clips) {
    const folder = `${String(c.n).padStart(2, "0")}-${slug(c.publish?.ytTitle ?? c.title, 60)}`;
    const base = c.render.file!.replace(/\.mp4$/, "");
    zip.file(c.render.file!, { name: `${folder}/video.mp4` });
    if (await exists(`${base}.jpg`)) zip.file(`${base}.jpg`, { name: `${folder}/thumbnail.jpg` });
    const p = c.publish;
    const tags = (p?.hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
    zip.append(p?.ytTitle ?? c.title, { name: `${folder}/title.txt` });
    zip.append(p?.description ?? "", { name: `${folder}/description.txt` });
    zip.append(tags, { name: `${folder}/hashtags.txt` });
    zip.append(
      JSON.stringify({ n: c.n, start: c.start, end: c.end, title: c.title, hook: c.hook, score: c.score, reason: c.reason, publish: p ?? null, source: job.url }, null, 2),
      { name: `${folder}/clip.json` },
    );
    lines.push(`${folder}/  ${fmt(c.start)}–${fmt(c.end)}  ${p?.ytTitle ?? c.title}`);
  }
  zip.append(lines.join("\n") + "\n", { name: "README.txt" });
  void zip.finalize();

  const name = `${slug(job.title ?? job.videoId, 50)}-clips.zip`;
  return new Response(Readable.toWeb(out) as ReadableStream, {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-cache" },
  });
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
function fmt(sec: number) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}
