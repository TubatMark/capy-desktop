import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clipThumbnail } from "../render";
import { run, withCancel, CancelledError } from "../exec";
import type { FrameCandidate, ThumbnailSource } from "../../lib/thumbnails";
async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function assert(signal: AbortSignal) {
  if (signal.aborted) throw new CancelledError();
}
function metrics(bytes: Buffer) {
  let sum = 0,
    gradient = 0,
    variance = 0;
  for (let i = 0; i < bytes.length; i++) {
    sum += bytes[i]!;
    if (i % 64) gradient += Math.abs(bytes[i]! - bytes[i - 1]!);
  }
  const mean = sum / bytes.length;
  for (const value of bytes) variance += (value - mean) ** 2;
  const sharpness = gradient / bytes.length,
    exposure = Math.max(0, 1 - Math.abs(mean - 128) / 128);
  return {
    sharpness,
    exposure,
    variance: variance / bytes.length,
    score: sharpness * exposure,
  };
}
function distance(a: Buffer, b: Buffer) {
  let delta = 0;
  for (let i = 0; i < a.length; i++) delta += Math.abs(a[i]! - b[i]!);
  return delta / a.length;
}
export async function extractFrameCandidates(
  source: ThumbnailSource,
  signal: AbortSignal,
  options: { directory?: string; timesUs?: number[]; finished?: boolean } = {},
): Promise<FrameCandidate[]> {
  assert(signal);
  const file = source.kind === "legacy" ? source.path : source.render.path;
  const checksum =
    source.kind === "legacy" ? source.checksum : source.render.checksum;
  const revision =
    source.kind === "legacy" ? source.revision : source.project.revision;
  if (
    source.kind === "project" &&
    (source.render.projectId !== source.project.id ||
      source.render.revision !== revision)
  )
    throw Error("Render does not match exact project revision");
  if ((await digest(file)) !== checksum)
    throw Error("Source render checksum changed");
  const directory =
    options.directory ??
    (await mkdtemp(path.join(tmpdir(), "capy-thumbnail-")));
  await mkdir(directory, { recursive: true });
  return withCancel(signal, async () => {
    const probe = JSON.parse(
      (
        await run(
          "ffprobe",
          ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
          { timeoutMs: 30_000 },
        )
      ).stdout,
    ) as {
      format: { duration: string };
      streams: { codec_type: string; avg_frame_rate: string }[];
    };
    const durationUs = Math.round(Number(probe.format.duration) * 1_000_000);
    if (
      !Number.isSafeInteger(durationUs) ||
      durationUs <= 0 ||
      durationUs > 1800_000_000
    )
      throw Error("Thumbnail footage must be a decoded clip under 30 minutes");
    const decoded = JSON.parse(
      (
        await run(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            file,
          ],
          { timeoutMs: 120_000 },
        )
      ).stdout,
    ) as { frames: { best_effort_timestamp_time?: string }[] };
    const decodedTimes = decoded.frames
      .map((f) => Math.round(Number(f.best_effort_timestamp_time) * 1_000_000))
      .filter((t) => Number.isSafeInteger(t) && t >= 0)
      .sort((a, b) => a - b);
    if (!decodedTimes.length)
      throw Error("Footage contains no decoded video frames");
    const last = decodedTimes.at(-1)!;
    const times =
      options.timesUs ??
      Array.from({ length: 36 }, (_, i) => Math.round((last * i) / 35));
    if (!options.timesUs) {
      const scene = await run(
        "ffmpeg",
        [
          "-hide_banner",
          "-i",
          file,
          "-vf",
          "select=gt(scene\\,0.25),showinfo",
          "-an",
          "-f",
          "null",
          "-",
        ],
        { timeoutMs: 120_000 },
      );
      const sceneTimes = [...scene.stderr.matchAll(/pts_time:([\d.]+)/g)].map(
        (match) => Math.round(Number(match[1]) * 1_000_000),
      );
      for (let i = 0; i < Math.min(64, sceneTimes.length); i++)
        times.push(
          sceneTimes[
            Math.floor(
              (i * sceneTimes.length) / Math.min(64, sceneTimes.length),
            )
          ]!,
        );
    }
    if (
      times.length > 100 ||
      times.some((t) => !Number.isSafeInteger(t) || t < 0 || t >= durationUs)
    )
      throw Error("Manual frame time is outside the clip");
    const all: { frame: FrameCandidate; signature: Buffer }[] = [];
    const snapped = times.map((time) =>
      decodedTimes.reduce(
        (best, candidate) =>
          Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best,
        decodedTimes[0]!,
      ),
    );
    const verifiedAssets = new Set<string>();
    for (const renderUs of [...new Set(snapped)].sort((a, b) => a - b)) {
      assert(signal);
      let assetId =
        source.kind === "legacy" ? source.assetId : source.render.id;
      let sourceUs =
        renderUs +
        (source.kind === "legacy" ? (source.sourceOffsetUs ?? 0) : 0);
      let extractionFile = file,
        extractionUs = renderUs,
        frameKind: FrameCandidate["frameKind"] = "finished";
      if (source.kind === "project") {
        const frame = Math.round(
          (renderUs * source.project.fps.numerator) /
            (1_000_000 * source.project.fps.denominator),
        );
        const visualTracks = new Set(
          source.project.tracks
            .filter((t) => t.kind === "video" && t.role !== "overlay")
            .map((t) => t.id),
        );
        const item = source.project.items.find(
          (i) =>
            i.assetId &&
            visualTracks.has(i.trackId) &&
            frame >= i.startFrame &&
            frame < i.startFrame + i.durationFrames,
        );
        if (item) {
          const asset = source.assets?.find((a) => a.id === item.assetId);
          assetId = item.assetId!;
          const localUs =
            (item.sourceInUs ?? 0) +
            Math.round(
              ((frame - item.startFrame) *
                1_000_000 *
                source.project.fps.denominator) /
                source.project.fps.numerator,
            );
          sourceUs =
            (asset?.kind === "image" ? 0 : localUs) +
            (asset?.sourceOffsetUs ?? 0);
          if (asset && !options.finished) {
            if (!verifiedAssets.has(asset.id)) {
              if ((await digest(asset.path)) !== asset.checksum)
                throw Error("Underlying source checksum changed");
              verifiedAssets.add(asset.id);
            }
            extractionFile = asset.path;
            extractionUs = asset.kind === "image" ? 0 : localUs;
            frameKind = "clean";
          }
        }
      }
      const id = createHash("sha256")
        .update(
          `${source.kind === "legacy" ? source.clipId : source.project.id}:${checksum}:${revision}:${renderUs}:${frameKind}`,
        )
        .digest("hex");
      const image = path.join(directory, `${id}.jpg`),
        raw = path.join(directory, `${id}.gray`);
      // Reuse the pipeline's finished-frame primitive without imposing the old 9:16 crop.
      await clipThumbnail(
        extractionFile,
        image,
        Math.max(0, extractionUs - 1000) / 1_000_000,
      );
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          image,
          "-vf",
          "scale=64:36",
          "-pix_fmt",
          "gray",
          "-f",
          "rawvideo",
          "-y",
          raw,
        ],
        { timeoutMs: 30_000 },
      );
      const signature = await readFile(raw);
      await rm(raw);
      const quality = metrics(signature);
      all.push({
        signature,
        frame: {
          id,
          path: image,
          checksum: await digest(image),
          assetId,
          sourceUs,
          renderUs,
          sourceRevision: revision,
          renderChecksum: checksum,
          frameKind,
          quality: {
            status: "usable",
            sharpness: quality.sharpness,
            exposure: quality.exposure,
            score: quality.score,
            ...(quality.variance < 40 ||
            quality.exposure < 0.12 ||
            quality.sharpness < 1
              ? {
                  status: "fallback" as const,
                  reason:
                    "Low-quality footage: use the manual frame selector or replace the source.",
                }
              : {}),
          },
        },
      });
    }
    const ranked = all
      .filter((x) => x.frame.quality.status === "usable")
      .sort((a, b) => b.frame.quality.score - a.frame.quality.score);
    const distinct: typeof ranked = [];
    for (const candidate of ranked)
      if (
        distinct.every(
          (other) => distance(candidate.signature, other.signature) > 4,
        )
      ) {
        distinct.push(candidate);
        if (distinct.length === 12) break;
      }
    const selected = distinct.length
      ? distinct
      : all
          .sort((a, b) => b.frame.quality.score - a.frame.quality.score)
          .slice(0, 1);
    assert(signal);
    return selected.map((x) => x.frame);
  });
}
