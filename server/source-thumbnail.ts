import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SourceThumbnailRef } from "../lib/thumbnails";
import { checksum } from "./studio/assets";

/** Best first. sd is 4:3 with letterbox bars for 16:9 videos; composition crops it back to 16:9. (hq, 480
 *  wide, is never sharp enough; see MIN_WIDTH.) */
export const SOURCE_THUMBNAIL_SIZES = ["maxresdefault", "sddefault"] as const;
export const sourceThumbnailUrl = (videoId: string, size: string) =>
  `https://i.ytimg.com/vi/${videoId}/${size}.jpg`;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_BYTES = 8 * 1024 * 1024;
/** YouTube answers a missing maxres with a 120×90 grey placeholder, and a 480×360 hq copy turns soft when
 *  blown up to the card, so only sharp copies count; otherwise the clip's own frame designs lead. */
const MIN_WIDTH = 640;

/** Returns the image bytes, or undefined when the image doesn't exist. May throw on network errors. */
export type FetchImage = (
  url: string,
  signal: AbortSignal,
) => Promise<Uint8Array | undefined>;

export interface CachedSourceThumbnail extends SourceThumbnailRef {
  path: string;
  width: number;
  height: number;
}

export const fetchImage: FetchImage = async (url, signal) => {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: "error",
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("image/") ||
    Number(response.headers.get("content-length") ?? 0) > MAX_BYTES
  )
    return undefined;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length <= MAX_BYTES ? bytes : undefined;
};

/** Width/height from a baseline or progressive JPEG's frame header; undefined when not a JPEG. */
export function jpegSize(bytes: Uint8Array) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      return {
        height: (bytes[i + 5]! << 8) | bytes[i + 6]!,
        width: (bytes[i + 7]! << 8) | bytes[i + 8]!,
      };
    i += 2 + length;
  }
  return undefined;
}

/**
 * The source video's own YouTube thumbnail, fetched once and cached in `directory` with its checksum.
 * Undefined when the video has none we can use (offline, 404, placeholder); never throws for that.
 */
export async function sourceThumbnail(
  input: { videoId: string; directory: string },
  signal: AbortSignal,
  fetcher: FetchImage = fetchImage,
): Promise<CachedSourceThumbnail | undefined> {
  if (!VIDEO_ID.test(input.videoId)) return undefined;
  const meta = path.join(input.directory, "source-thumbnail.json"),
    file = path.join(input.directory, `source-thumbnail-${input.videoId}.jpg`);
  try {
    const cached = JSON.parse(
      await readFile(meta, "utf8"),
    ) as CachedSourceThumbnail;
    if (
      cached.videoId === input.videoId &&
      existsSync(file) &&
      (await checksum(file)) === cached.checksum
    )
      return { ...cached, path: file };
  } catch {
    /* not cached yet */
  }
  for (const size of SOURCE_THUMBNAIL_SIZES) {
    signal.throwIfAborted();
    const url = sourceThumbnailUrl(input.videoId, size);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await fetcher(url, signal);
    } catch {
      if (signal.aborted) throw signal.reason;
      continue;
    }
    const dimensions = bytes && jpegSize(bytes);
    if (!bytes || !dimensions || dimensions.width < MIN_WIDTH) continue;
    await mkdir(input.directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, file);
    const result: CachedSourceThumbnail = {
      videoId: input.videoId,
      url,
      checksum: await checksum(file),
      path: file,
      ...dimensions,
    };
    const temporaryMeta = `${meta}.${randomUUID()}.tmp`;
    await writeFile(temporaryMeta, JSON.stringify(result));
    await rename(temporaryMeta, meta);
    return result;
  }
  return undefined;
}
