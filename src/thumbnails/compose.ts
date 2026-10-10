import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { run, withCancel } from "../exec";
import { checksum } from "../../server/studio/assets";
import {
  THUMBNAIL_DIMENSIONS,
  type FrameCandidate,
  type ThumbnailBrief,
  type ThumbnailLayer,
  type ThumbnailVersion,
} from "../../lib/thumbnails";
const fontFiles = [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
];
function escaped(file: string) {
  return file
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");
}
function wrap(text: string, max: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const chunks = word.match(new RegExp(`.{1,${max}}`, "gu")) ?? [];
    for (const chunk of chunks) {
      if (line && line.length + chunk.length + 1 > max) {
        lines.push(line);
        line = "";
      }
      line += (line ? " " : "") + chunk;
    }
  }
  if (line) lines.push(line);
  return lines;
}
export function thumbnailLayers(
  brief: ThumbnailBrief,
  frame: FrameCandidate,
): ThumbnailLayer[] {
  const { width: w, height: h } = THUMBNAIL_DIMENSIONS[brief.aspect];
  const m = Math.round(Math.min(w, h) * 0.06),
    portrait = h > w;
  const image: ThumbnailLayer = {
    id: "source",
    kind: "image",
    assetId: frame.id,
    x: m,
    y: m,
    width: w - 2 * m,
    height: Math.round(h * 0.6),
  };
  const text: ThumbnailLayer = {
    id: "headline",
    kind: "text",
    text: brief.headline,
    x: m,
    y: Math.round(h * 0.72),
    width: w - 2 * m,
    height: Math.round(h * 0.22),
    color: "ffffff",
    fontSize: Math.round(Math.min(w, h) * 0.071),
    fontFamily: "Arial Bold",
  };
  const background: ThumbnailLayer = {
    id: "background",
    kind: "shape",
    x: 0,
    y: 0,
    width: w,
    height: h,
    color:
      brief.layout === "bold"
        ? brief.style === "clean"
          ? "26343c"
          : "2234b5"
        : brief.layout === "editorial"
          ? "141b23"
          : "f4f1e8",
  };
  const accent: ThumbnailLayer = {
    id: "accent",
    kind: "shape",
    x: m,
    y: Math.round(h * 0.67),
    width: Math.round(w * 0.2),
    height: Math.round(h * 0.015),
    color: brief.layout === "bold" ? "ffd94a" : "ef6544",
  };
  if (brief.layout === "editorial" && !portrait) {
    image.x = Math.round(w * 0.45);
    image.y = m;
    image.width = Math.round(w * 0.49);
    image.height = h - 2 * m;
    text.width = Math.round(w * 0.33);
    text.y = Math.round(h * 0.29);
    text.height = Math.round(h * 0.55);
    accent.y = Math.round(h * 0.18);
  }
  if (brief.layout === "minimal") {
    image.y = Math.round(h * 0.24);
    image.height = Math.round(h * 0.65);
    text.y = m;
    text.height = Math.round(h * 0.15);
    text.color = "141b23";
    text.fontSize = Math.round(Math.min(w, h) * 0.055);
    accent.y = Math.round(h * 0.94);
    accent.width = w - 2 * m;
  }
  return [background, image, accent, text];
}
/** Local typography remains editable. Contain preserves the source subject, without guessed segmentation or image-model replacement. */
export async function composeThumbnail(
  input: {
    brief: ThumbnailBrief;
    frame: FrameCandidate;
    directory: string;
    background?: string;
    layers?: ThumbnailLayer[];
    textFree?: boolean;
  },
  signal: AbortSignal,
): Promise<{ layers: ThumbnailLayer[]; versions: ThumbnailVersion[] }> {
  signal.throwIfAborted();
  await mkdir(input.directory, { recursive: true });
  const { width, height } = THUMBNAIL_DIMENSIONS[input.brief.aspect];
  const layers = input.layers ?? thumbnailLayers(input.brief, input.frame),
    base = layers.find((l) => l.id === "background")!,
    image = layers.find((l) => l.kind === "image")!;
  if (
    !image ||
    !base ||
    layers.some(
      (l) =>
        ![l.x, l.y, l.width, l.height].every(Number.isFinite) ||
        l.width <= 0 ||
        l.height <= 0 ||
        l.x < 0 ||
        l.y < 0 ||
        l.x + l.width > width ||
        l.y + l.height > height ||
        (l.color && !/^[a-f0-9]{6}$/i.test(l.color)),
    )
  )
    throw Error("Thumbnail layers exceed canvas or contain unsupported colors");
  const args = [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x${base.color}:s=${width}x${height}:r=1`,
    "-i",
    input.frame.path,
  ];
  if (input.background) args.push("-i", input.background);
  const filters: string[] = [];
  let current = "base";
  if (input.background) {
    filters.push(
      `[2:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[background]`,
    );
    filters.push("[0:v][background]overlay=0:0:shortest=1[base]");
  } else filters.push("[0:v]null[base]");
  filters.push(
    `[1:v]format=rgba,scale=${image.width}:${image.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${image.width}:${image.height}:(ow-iw)/2:(oh-ih)/2:0x${base.color}[subject]`,
    `[${current}][subject]overlay=${image.x}:${image.y}:shortest=1[source]`,
  );
  current = "source";
  let index = 0;
  for (const layer of layers.filter(
    (l) => l.kind === "shape" && l.id !== "background",
  )) {
    const next = `shape${index++}`;
    filters.push(
      `[${current}]drawbox=x=${layer.x}:y=${layer.y}:w=${layer.width}:h=${layer.height}:color=0x${layer.color}:t=fill[${next}]`,
    );
    current = next;
  }
  const font = fontFiles.find(existsSync);
  if (!font)
    throw Error(
      "Install Arial or DejaVu Sans for local editable thumbnail text",
    );
  if (!input.textFree)
    for (const layer of layers.filter((l) => l.kind === "text")) {
      if (typeof layer.text !== "string" || layer.text.length > 120)
        throw Error("Editable headline exceeds 120 characters");
      let size = layer.fontSize ?? 64,
        lines = wrap(
          layer.text,
          Math.max(1, Math.floor(layer.width / (size * 0.7))),
        );
      while (
        (lines.length * size * 1.25 > layer.height ||
          Math.max(...lines.map((l) => l.length)) * size * 0.7 > layer.width) &&
        size > 16
      ) {
        size -= 2;
        lines = wrap(
          layer.text,
          Math.max(1, Math.floor(layer.width / (size * 0.7))),
        );
      }
      if (lines.length * size * 1.25 > layer.height)
        throw Error("Text overflows thumbnail safe area");
      for (const [n, line] of lines.entries()) {
        const textFile = `text-${index}.txt`;
        await writeFile(path.join(input.directory, textFile), line);
        const next = `text${index++}`;
        filters.push(
          `[${current}]drawtext=fontfile='${escaped(font)}':textfile=${textFile}:expansion=none:fontsize=${size}:fontcolor=0x${layer.color ?? "ffffff"}:x=${layer.x}:y=${Math.round(layer.y + n * size * 1.25)}[${next}]`,
        );
        current = next;
      }
    }
  const png = path.join(input.directory, "design.png"),
    jpg = path.join(input.directory, "design.jpg");
  await withCancel(signal, async () => {
    await run(
      "ffmpeg",
      [
        ...args,
        "-filter_complex",
        filters.join(";"),
        "-map",
        `[${current}]`,
        "-frames:v",
        "1",
        "-y",
        png,
      ],
      { cwd: input.directory, timeoutMs: 60_000 },
    );
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        png,
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        "2",
        "-y",
        jpg,
      ],
      { timeoutMs: 30_000 },
    );
  });
  return {
    layers,
    versions: await Promise.all(
      (
        [
          { path: png, format: "png" },
          { path: jpg, format: "jpg" },
        ] as const
      ).map(async (file) => ({
        id: randomUUID(),
        ...file,
        checksum: await checksum(file.path),
        width,
        height,
        createdAt: Date.now(),
      })),
    ),
  };
}
