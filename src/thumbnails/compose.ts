import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
export interface ThumbnailBackgroundAsset {
  assetId: string;
  path: string;
  checksum: string;
}
const fonts = [
  {
    family: "Arial Bold",
    path: "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  },
  {
    family: "DejaVu Sans Bold",
    path: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  },
  { family: "Arial", path: "/System/Library/Fonts/Supplemental/Arial.ttf" },
  {
    family: "DejaVu Sans",
    path: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  },
];
function escaped(file: string) {
  return file
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");
}
function fontFor(layer: ThumbnailLayer) {
  const desired = fonts.find(
    (font) => font.family === layer.fontFamily && existsSync(font.path),
  );
  const font =
    desired ??
    (!layer.textLayout
      ? fonts.find((font) => existsSync(font.path))
      : undefined);
  if (!font)
    throw Error(
      "The saved thumbnail font is unavailable. Install Arial or DejaVu Sans, or select an installed font.",
    );
  return font;
}
/** Measures the same shaped glyph runs used by drawtext, including kerning and wide glyphs. */
async function fittedText(
  layer: ThumbnailLayer,
  directory: string,
  signal: AbortSignal,
) {
  if (
    typeof layer.text !== "string" ||
    layer.text.length > 120 ||
    /[\x00-\x1f]/.test(layer.text)
  )
    throw Error(
      "Editable headline must contain at most 120 printable characters",
    );
  const font = fontFor(layer),
    fontChecksum = await checksum(font.path);
  if (
    layer.textLayout &&
    layer.textLayout.fontChecksum !== fontChecksum &&
    layer.fontFamily === layer.textLayout.fontFamily
  )
    throw Error(
      "The saved font bytes changed. Re-select the font before rendering.",
    );
  const requested = layer.fontSize ?? 64;
  if (!Number.isSafeInteger(requested) || requested < 16 || requested > 256)
    throw Error("Thumbnail font size must be 16–256 pixels");
  const deadline = Date.now() + 30_000;
  let measurements = 0;
  const measured = new Map<string, number>();
  const command = async (args: string[]) => {
    signal.throwIfAborted();
    if (Date.now() >= deadline || measurements++ >= 128)
      throw Error("Thumbnail text measurement exceeded its bounded allowance");
    return withCancel(signal, () =>
      run("ffmpeg", args, {
        cwd: directory,
        timeoutMs: Math.min(5_000, deadline - Date.now()),
      }),
    );
  };
  const widths = async (text: string, size: number) => {
    const graphemes = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        text,
      ),
    ].map((segment) => segment.segment);
    const prefixes = graphemes.map((_, index) =>
      graphemes.slice(0, index + 1).join(""),
    );
    const missing = [...new Set(prefixes)].filter(
      (prefix) => !measured.has(`${size}:${prefix}`),
    );
    if (missing.length) {
      const file = `glyph-widths-${measurements}.txt`;
      await writeFile(path.join(directory, file), missing.join("\n"));
      const result = await command([
        "-v",
        "debug",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=64x64",
        "-vf",
        `drawtext=fontfile='${escaped(font.path)}':textfile=${file}:expansion=none:fontsize=${size}:fontcolor=white:x=0:y=0`,
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ]);
      const actual = new Map<number, number>();
      for (const match of result.stderr.matchAll(
        /Line:\s*(\d+)\s*--[^\n]*width64:\s*(-?\d+)/g,
      ))
        actual.set(Number(match[1]), Math.ceil(Number(match[2]) / 64));
      if (actual.size !== missing.length)
        throw Error(
          "This ffmpeg cannot report actual glyph layout; install a build with current drawtext support",
        );
      for (const [index, prefix] of missing.entries())
        measured.set(`${size}:${prefix}`, actual.get(index)!);
      await rm(path.join(directory, file));
    }
    return prefixes.map((prefix) => ({
      text: prefix,
      width: measured.get(`${size}:${prefix}`)!,
    }));
  };
  const wrap = async (size: number) => {
    let remaining = layer.text!.trim();
    const lines: { text: string; width: number }[] = [];
    while (remaining) {
      const prefixes = await widths(remaining, size),
        fitting = prefixes.filter((prefix) => prefix.width <= layer.width - 4);
      if (!fitting.length) return undefined;
      let selected = fitting.at(-1)!;
      if (selected.text.length < remaining.length) {
        const boundary = selected.text.lastIndexOf(" ");
        if (boundary > 0)
          selected = prefixes.find(
            (prefix) => prefix.text === selected.text.slice(0, boundary),
          )!;
      }
      lines.push(selected);
      remaining = remaining.slice(selected.text.length).trimStart();
    }
    return lines;
  };
  let size = requested;
  for (let attempt = 0; attempt < 12; attempt++) {
    const lines = await wrap(size),
      advance = Math.ceil(size * 1.25);
    if (!lines || lines.length * advance > layer.height) {
      if (size === 16) break;
      const ratio = lines
        ? Math.sqrt(layer.height / (lines.length * advance))
        : 0.8;
      size = Math.max(16, Math.min(size - 1, Math.floor(size * ratio * 0.98)));
      continue;
    }
    // A raster check catches ink overhang, diacritics and vertical extents beyond advance metrics.
    const margin = size * 2 + 16,
      canvasWidth = Math.ceil((layer.width + margin * 2) / 2) * 2,
      canvasHeight = Math.ceil((layer.height + margin * 2) / 2) * 2;
    const filters = ["format=gray"];
    for (const [index, line] of lines.entries()) {
      const file = `glyph-line-${index}.txt`;
      await writeFile(path.join(directory, file), line.text);
      filters.push(
        `drawtext=fontfile='${escaped(font.path)}':textfile=${file}:expansion=none:fontsize=${size}:fontcolor=white:x=${margin}:y=${margin + index * advance}`,
      );
    }
    const raster = `glyph-bounds-${attempt}.gray`;
    await command([
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=black:s=${canvasWidth}x${canvasHeight}`,
      "-vf",
      filters.join(","),
      "-frames:v",
      "1",
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      "-y",
      raster,
    ]);
    const bytes = await readFile(path.join(directory, raster));
    if (bytes.length !== canvasWidth * canvasHeight)
      throw Error("Unexpected glyph measurement raster dimensions");
    await rm(path.join(directory, raster));
    let minX = canvasWidth,
      minY = canvasHeight,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < canvasHeight; y++)
      for (let x = 0; x < canvasWidth; x++)
        if (bytes[y * canvasWidth + x]! > 1) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
    const offsetX = maxX < 0 ? 0 : Math.max(0, margin - minX),
      offsetY = maxY < 0 ? 0 : Math.max(0, margin - minY);
    const width = maxX < 0 ? 0 : maxX - margin + 1 + offsetX,
      height = maxY < 0 ? 0 : maxY - margin + 1 + offsetY;
    if (width <= layer.width && height <= layer.height) {
      layer.fontSize = size;
      layer.fontFamily = font.family;
      layer.textLayout = {
        fontFamily: font.family,
        fontChecksum,
        fontSize: size,
        lineAdvance: advance,
        width,
        height,
        offsetX,
        offsetY,
        lines: lines.map((line, index) => ({ ...line, y: index * advance })),
      };
      return {
        font: font.path,
        size,
        lines: layer.textLayout.lines,
        offsetX,
        offsetY,
      };
    }
    if (size === 16) break;
    const ratio = Math.min(
      layer.width / Math.max(1, width),
      layer.height / Math.max(1, height),
    );
    size = Math.max(16, Math.min(size - 1, Math.floor(size * ratio * 0.98)));
  }
  throw Error(
    "Text overflows thumbnail safe area at the minimum readable font size",
  );
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
    background?: ThumbnailBackgroundAsset;
    layers?: ThumbnailLayer[];
    textFree?: boolean;
  },
  signal: AbortSignal,
): Promise<{ layers: ThumbnailLayer[]; versions: ThumbnailVersion[] }> {
  signal.throwIfAborted();
  await mkdir(input.directory, { recursive: true });
  const { width, height } = THUMBNAIL_DIMENSIONS[input.brief.aspect];
  const layers = structuredClone(
      input.layers ?? thumbnailLayers(input.brief, input.frame),
    ),
    base = layers.find((l) => l.id === "background")!,
    image = layers.find((l) => l.id === "source")!;
  if (
    !image ||
    !base ||
    image.kind !== "image" ||
    !["shape", "image"].includes(base.kind) ||
    layers.some(
      (layer) =>
        layer.kind === "image" && !["source", "background"].includes(layer.id),
    ) ||
    image.assetId !== input.frame.id ||
    new Set(layers.map((layer) => layer.id)).size !== layers.length ||
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
  if (
    image.crop &&
    (![image.crop.x, image.crop.y, image.crop.width, image.crop.height].every(
      Number.isFinite,
    ) ||
      image.crop.x < 0 ||
      image.crop.y < 0 ||
      image.crop.width <= 0 ||
      image.crop.height <= 0 ||
      image.crop.x + image.crop.width > 1 ||
      image.crop.y + image.crop.height > 1)
  )
    throw Error("Invalid normalized source crop");
  if ((await checksum(input.frame.path)) !== input.frame.checksum)
    throw Error("Source frame bytes changed before composition");
  if (
    base.kind === "image" &&
    (!input.background || base.assetId !== input.background.assetId)
  )
    throw Error(
      "Saved background layer requires its matching background asset",
    );
  if (input.background) {
    if (
      (await checksum(input.background.path)) !== input.background.checksum ||
      input.background.assetId !== input.background.checksum
    )
      throw Error(
        "Background asset identity/checksum changed before composition",
      );
    base.kind = "image";
    base.assetId = input.background.assetId;
  }
  const baseColor = base.color ?? "000000";
  const args = [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x${baseColor}:s=${width}x${height}:r=1`,
    "-i",
    input.frame.path,
  ];
  if (input.background) args.push("-i", input.background.path);
  const filters: string[] = [];
  let current = "base";
  if (input.background) {
    filters.push(
      `[2:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[background]`,
    );
    filters.push("[0:v][background]overlay=0:0:shortest=1[base]");
  } else filters.push("[0:v]null[base]");
  filters.push(
    `[1:v]format=rgba,${image.crop ? `crop=iw*${image.crop.width}:ih*${image.crop.height}:iw*${image.crop.x}:ih*${image.crop.y},` : ""}scale=${image.width}:${image.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${image.width}:${image.height}:(ow-iw)/2:(oh-ih)/2:0x${baseColor}[subject]`,
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
  if (!input.textFree)
    for (const layer of layers.filter((l) => l.kind === "text")) {
      const fitted = await fittedText(layer, input.directory, signal);
      for (const line of fitted.lines) {
        const textFile = `text-${index}.txt`;
        await writeFile(path.join(input.directory, textFile), line.text);
        const next = `text${index++}`;
        filters.push(
          `[${current}]drawtext=fontfile='${escaped(fitted.font)}':textfile=${textFile}:expansion=none:fontsize=${fitted.size}:fontcolor=0x${layer.color ?? "ffffff"}:x=${layer.x + fitted.offsetX}:y=${layer.y + line.y + fitted.offsetY}[${next}]`,
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
