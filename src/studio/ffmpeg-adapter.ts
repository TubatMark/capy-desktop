import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AssetRef,
  ExportPreset,
  ProjectDocument,
  RenderArtifact,
} from "../../lib/studio/types";
import { validateProject } from "../../lib/studio/operations";
import { numberUs } from "../../lib/studio/time";
import { motionExpression } from "../../lib/studio/templates";
import { sourcePhaseUs } from "../../lib/studio/audio";
import { buildAudioPlan, audioGainAtFrame, type AudioPlan } from "./audio-plan";
import { run, withCancel, throwIfCancelled } from "../exec";

export const NORMALIZATION_POLICY =
  "sdr-cfr-v4: duration-controlled-stereo-similarity-overlap-add; declarative-linear-motion; freeze-silent; display-rotation; requested-source-clock-nearest-presentation; display-aspect-preserving-square-pixel-resample-before-crop-fit; untagged-SDR-assumed-bt601; output-bt709; HDR-rejected; stereo-48000";
export const NORMALIZED_RENDERER_VERSION = "ffmpeg-studio-5";
export const DEFAULT_EXPORT_PRESET: ExportPreset = {
  aspect: "portrait",
  fps: 30,
  codec: "h264-aac",
};
export function validatePreset(value: unknown): ExportPreset {
  const p = value as ExportPreset;
  if (
    !p ||
    Object.keys(p).some((k) => !["aspect", "fps", "codec"].includes(k)) ||
    !["project", "portrait", "landscape", "square"].includes(p.aspect) ||
    p.fps !== 30 ||
    p.codec !== "h264-aac"
  )
    throw Error("Unsupported export preset");
  return structuredClone(p);
}
export interface NormalizedPlan {
  document: ProjectDocument;
  assets: AssetRef[];
  audio: AudioPlan;
  preset: ExportPreset;
  width: number;
  height: number;
  frameCount: number;
  duration: number;
  planHash: string;
  normalizationPolicy: string;
  font: string;
  fonts: Record<string, string>;
  fontChecksums: Record<string, string>;
  inputMatrices: Record<string, string>;
  inputGeometry: Record<
    string,
    {
      width?: number;
      height?: number;
      sampleAspectRatio: string;
      rotation: number;
    }
  >;
}
async function hash(file: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
export async function probeMedia(file: string) {
  return JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ])
    ).stdout,
  ) as {
    streams: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      sample_rate?: string;
      color_transfer?: string;
      color_space?: string;
      color_primaries?: string;
      duration?: string;
      nb_read_frames?: string;
      avg_frame_rate?: string;
      sample_aspect_ratio?: string;
      side_data_list?: { rotation?: number }[];
    }[];
    format: { duration?: string };
  };
}
export async function compileNormalizedProject(
  document: ProjectDocument,
  inputAssets: AssetRef[],
  preset: ExportPreset = { aspect: "project", fps: 30, codec: "h264-aac" },
): Promise<NormalizedPlan> {
  const doc = structuredClone(document),
    selected = validatePreset(preset),
    sourceAssets = structuredClone(inputAssets);
  validateProject(doc);
  if (!doc.items.length) throw Error("Add media before exporting");
  const assets: AssetRef[] = [];
  const inputMatrices: Record<string, string> = {};
  const inputGeometry: NormalizedPlan["inputGeometry"] = {};
  for (const id of new Set(
    doc.items.flatMap((i) => (i.assetId ? [i.assetId] : [])),
  )) {
    const a = structuredClone(sourceAssets.find((a) => a.id === id));
    if (!a || a.status !== "ready" || !path.isAbsolute(a.location))
      throw Error("Missing ready render asset");
    if ((await hash(a.location)) !== a.checksum)
      throw Error("Asset checksum changed");
    const probe = await probeMedia(a.location);
    if (
      probe.streams.some((s) =>
        ["smpte2084", "arib-std-b67"].includes(s.color_transfer ?? ""),
      )
    )
      throw Error("HDR media needs an SDR copy before export");
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    if (
      video?.color_primaries &&
      !["bt709", "smpte170m", "bt470bg", "unknown"].includes(
        video.color_primaries,
      )
    )
      throw Error("Unsupported wide-gamut media; import an SDR BT.709 copy");
    inputMatrices[a.id] = video?.color_space === "bt709" ? "bt709" : "bt601";
    if (video)
      inputGeometry[a.id] = {
        width: video.width,
        height: video.height,
        sampleAspectRatio: video.sample_aspect_ratio ?? "unspecified",
        rotation:
          video.side_data_list?.find((s) => s.rotation !== undefined)
            ?.rotation ?? 0,
      };
    a.streams = probe.streams
      .filter((s) => s.codec_type === "video" || s.codec_type === "audio")
      .map((s) => ({
        kind: s.codec_type as "video" | "audio",
        codec: s.codec_name,
        width: s.width,
        height: s.height,
        sampleRate: Number(s.sample_rate) || undefined,
      }));
    if (
      (a.kind === "video" && !a.streams.some((s) => s.kind === "video")) ||
      (a.kind === "audio" && !a.streams.some((s) => s.kind === "audio"))
    )
      throw Error("Unsupported media streams");
    assets.push(a);
  }
  const font = [
    process.env.CAPY_RENDER_FONT,
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].find((f) => f && existsSync(f));
  if (!font)
    throw Error(
      "A local Arial or DejaVu Sans font is required for Studio export",
    );
  const fonts: Record<string, string> = { Arial: font };
  for (const family of new Set(
    doc.captionCues.map((c) => c.fontFamily ?? "Arial"),
  )) {
    if (family === "Arial") continue;
    const candidates =
      family === "Georgia"
        ? [
            "/System/Library/Fonts/Supplemental/Georgia.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
          ]
        : family === "monospace"
          ? [
              "/System/Library/Fonts/Menlo.ttc",
              "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            ]
          : [];
    const resolved = candidates.find(existsSync);
    if (!resolved) throw Error(`Unsupported or missing export font: ${family}`);
    fonts[family] = resolved;
  }
  if (doc.items.some((i) => i.text?.fontAssetId))
    throw Error("Custom title fonts are not supported by this renderer");
  const dimensions =
    selected.aspect === "project"
      ? doc.canvas
      : selected.aspect === "portrait"
        ? { width: 1080, height: 1920 }
        : selected.aspect === "landscape"
          ? { width: 1920, height: 1080 }
          : { width: 1080, height: 1080 };
  const projectFrames = Math.max(
    ...doc.items.map((i) => i.startFrame + i.durationFrames),
  );
  const frameCount = Math.round(
    (projectFrames * doc.fps.denominator * 30) / doc.fps.numerator,
  );
  if (frameCount < 1 || dimensions.width % 2 || dimensions.height % 2)
    throw Error("Export needs positive even dimensions and at least one frame");
  const audio = buildAudioPlan(doc, assets);
  const plan = {
    document: doc,
    assets,
    audio,
    preset: selected,
    ...dimensions,
    frameCount,
    duration: frameCount / 30,
    normalizationPolicy: NORMALIZATION_POLICY,
    font,
    fonts,
    fontChecksums: Object.fromEntries(
      await Promise.all(
        Object.entries(fonts).map(async ([name, file]) => [
          name,
          await hash(file),
        ]),
      ),
    ),
    inputMatrices,
    inputGeometry,
  };
  return {
    ...plan,
    planHash: createHash("sha256")
      .update(
        JSON.stringify({
          ...plan,
          fontChecksums: await Promise.all(
            Object.entries(fonts).map(async ([name, file]) => [
              name,
              await hash(file),
            ]),
          ),
          renderer: NORMALIZED_RENDERER_VERSION,
        }),
      )
      .digest("hex"),
  };
}
const sec = (frames: number, doc: ProjectDocument) =>
  (frames * doc.fps.denominator) / doc.fps.numerator;
function wrapCaption(text: string, columns: number) {
  return text
    .split("\n")
    .flatMap((line) => {
      const lines: string[] = [];
      let current = "";
      for (const word of line.split(/\s+/)) {
        for (let offset = 0; offset < word.length; offset += columns) {
          const piece = word.slice(offset, offset + columns);
          if (current && current.length + piece.length + 1 > columns) {
            lines.push(current);
            current = "";
          }
          current += (current ? " " : "") + piece;
        }
      }
      lines.push(current);
      return lines;
    })
    .join("\n");
}
const safeColor = (v: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff");
const filterPath = (v: string) =>
  v.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "'\\''");
/**
 * Duration-controlled, stereo-coherent similarity overlap-add. Every grain's
 * center follows the exact source clock; correlation adjusts phase by at most
 * 8 ms, never the cumulative clock. The 20 ms window / 5 ms hop covers short
 * transients without treating transcript boundaries as audio cuts.
 * Memory is one source window and one output window, independent of clip length.
 */
async function stretchTempo(
  source: Awaited<ReturnType<typeof open>>,
  target: string,
  startUs: number,
  endUs: number,
  speed: number,
) {
  if (speed !== 0.5 && speed !== 2) throw Error("Unsupported tempo ratio");
  const rate = 48000,
    window = 960,
    hop = 240,
    search = 384;
  const sourceStart = Math.round((startUs * rate) / 1e6);
  const sourceEnd = Math.min(
    Math.round((endUs * rate) / 1e6),
    Math.floor((await source.stat()).size / 8),
  );
  if (sourceEnd <= sourceStart)
    throw Error("No decoded audio in selected source span");
  const count = Math.round((sourceEnd - sourceStart) / speed);
  const weights = new Float64Array(window),
    mix = new Float64Array(window * 2);
  const hann = Float64Array.from(
    { length: window },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / window),
  );
  const readBuffer = Buffer.alloc((window + 2 * search) * 8),
    output = Buffer.alloc(hop * 8);
  let previous: Float32Array | undefined;
  const writer = await open(target, "w");
  try {
    for (
      let outputStart = -window + hop;
      outputStart < count;
      outputStart += hop
    ) {
      throwIfCancelled();
      const nominal =
        sourceStart +
        Math.round((outputStart + window / 2) * speed - window / 2);
      const readStart = Math.max(sourceStart, nominal - search),
        readEnd = Math.min(sourceEnd, nominal + search + window);
      const requested = Math.max(0, readEnd - readStart) * 8;
      const bytes = requested
        ? (await source.read(readBuffer, 0, requested, readStart * 8)).bytesRead
        : 0;
      const samples = new Float32Array(
        readBuffer.buffer,
        readBuffer.byteOffset,
        bytes / 4,
      );
      for (const value of samples)
        if (!Number.isFinite(value))
          throw Error("Invalid decoded audio sample");
      const value = (index: number, channel: number) =>
        samples[(index - readStart) * 2 + channel] ?? 0;
      let chosen = nominal,
        best = -Infinity;
      if (previous) {
        for (let delta = -search; delta <= search; delta += 8) {
          let dot = 0,
            a2 = 0,
            b2 = 0;
          for (let i = 0; i < window - hop; i += 8)
            for (let channel = 0; channel < 2; channel++) {
              const a = previous[(i + hop) * 2 + channel]!,
                b = value(nominal + delta + i, channel);
              dot += a * b;
              a2 += a * a;
              b2 += b * b;
            }
          // The distance penalty makes silence use its nominal source clock.
          const score =
            (a2 * b2 > 1e-14 ? dot / Math.sqrt(a2 * b2) : 0) -
            (Math.abs(delta) / search) * 0.025;
          if (score > best) {
            best = score;
            chosen = nominal + delta;
          }
        }
      }
      previous = new Float32Array(window * 2);
      for (let i = 0; i < window; i++) {
        const sourceIndex = chosen + i,
          available =
            sourceIndex >= readStart && sourceIndex < readStart + bytes / 8;
        for (let channel = 0; channel < 2; channel++)
          previous[i * 2 + channel] = value(sourceIndex, channel);
        if (!available) continue;
        const weight = hann[i]!;
        weights[i]! += weight;
        mix[i * 2]! += previous[i * 2]! * weight;
        mix[i * 2 + 1]! += previous[i * 2 + 1]! * weight;
      }
      if (outputStart >= 0) {
        const length = Math.min(hop, count - outputStart);
        for (let i = 0; i < length; i++) {
          let edge: Buffer | undefined;
          if (weights[i]! <= 1e-12) {
            // Only possible at a very short clip boundary. Preserve an actual
            // source sample rather than manufacturing missing-span silence.
            edge = Buffer.alloc(8);
            const index = Math.min(
              sourceEnd - 1,
              sourceStart + Math.floor((outputStart + i) * speed),
            );
            if ((await source.read(edge, 0, 8, index * 8)).bytesRead !== 8)
              throw Error("Incomplete source audio");
          }
          for (let channel = 0; channel < 2; channel++) {
            const sample = edge
              ? edge.readFloatLE(channel * 4)
              : mix[i * 2 + channel]! / weights[i]!;
            if (!Number.isFinite(sample))
              throw Error("Invalid stretched audio sample");
            output.writeFloatLE(sample, (i * 2 + channel) * 4);
          }
        }
        await writer.write(output, 0, length * 8);
      }
      weights.copyWithin(0, hop);
      weights.fill(0, window - hop);
      mix.copyWithin(0, hop * 2);
      mix.fill(0, (window - hop) * 2);
    }
  } finally {
    await writer.close();
  }
}

async function mixAudio(plan: NormalizedPlan, dir: string): Promise<string> {
  const rate = 48000,
    count = Math.round(plan.duration * rate),
    block = 4096;
  const decoded = new Map<string, Awaited<ReturnType<typeof open>>>();
  const clips = plan.audio.clips.filter((c) => c.enabled);
  const out = path.join(dir, "mix.f32");
  const writer = await open(out, "w");
  try {
    for (const id of new Set(clips.map((c) => c.assetId))) {
      const a = plan.assets.find((a) => a.id === id)!;
      const file = path.join(dir, `audio-${decoded.size}.f32`);
      await run("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-i",
        a.location,
        "-map",
        "0:a:0",
        "-ar",
        String(rate),
        "-ac",
        "2",
        "-f",
        "f32le",
        "-y",
        file,
      ]);
      decoded.set(`${id}@1`, await open(file, "r"));
    }
    for (const clip of clips.filter((c) => c.speed !== 1)) {
      const asset = plan.assets.find((a) => a.id === clip.assetId)!;
      for (const [index, segment] of clip.segments.entries()) {
        throwIfCancelled();
        const file = path.join(dir, `tempo-${decoded.size}.f32`);
        await stretchTempo(
          decoded.get(`${asset.id}@1`)!,
          file,
          numberUs(segment.sourceStartUs),
          numberUs(segment.sourceEndUs),
          clip.speed,
        );
        decoded.set(`${clip.itemId}:tempo:${index}`, await open(file, "r"));
      }
    }
    const entries = clips.map((clip) => ({
      clip,
      segments: clip.segments.map((s, index) => ({
        key:
          clip.speed === 1
            ? `${clip.assetId}@1`
            : `${clip.itemId}:tempo:${index}`,
        start: (numberUs(s.timelineStartUs) * rate) / 1e6,
        end:
          ((numberUs(s.timelineStartUs) + numberUs(s.durationUs)) * rate) / 1e6,
        source: clip.speed === 1 ? (numberUs(s.sourceStartUs) * rate) / 1e6 : 0,
      })),
      cache: Buffer.alloc(block * 8),
      cacheKey: "",
      cacheStart: -block,
      cacheCount: 0,
    }));
    for (let start = 0; start < count; start += block) {
      throwIfCancelled();
      const length = Math.min(block, count - start),
        samples = new Float32Array(length * 2);
      for (const entry of entries) {
        for (const s of entry.segments) {
          const first = Math.max(start, Math.ceil(s.start)),
            end = Math.min(start + length, Math.ceil(s.end));
          for (let n = first; n < end; n++) {
            const source = Math.max(0, Math.round(s.source + n - s.start));
            if (
              entry.cacheKey !== s.key ||
              source < entry.cacheStart ||
              source >= entry.cacheStart + entry.cacheCount
            ) {
              const read = await decoded
                .get(s.key)!
                .read(entry.cache, 0, entry.cache.length, source * 8);
              entry.cacheKey = s.key;
              entry.cacheStart = source;
              entry.cacheCount = read.bytesRead / 8;
            }
            if (source >= entry.cacheStart + entry.cacheCount) continue;
            const gain = audioGainAtFrame(
                plan.audio,
                entry.clip.itemId,
                ((n / rate) * plan.document.fps.numerator) /
                  plan.document.fps.denominator,
              ),
              offset = (source - entry.cacheStart) * 8;
            samples[(n - start) * 2]! += entry.cache.readFloatLE(offset) * gain;
            samples[(n - start) * 2 + 1]! +=
              entry.cache.readFloatLE(offset + 4) * gain;
          }
        }
      }
      await writer.write(Buffer.from(samples.buffer));
    }
  } finally {
    await writer.close();
    for (const handle of decoded.values()) await handle.close();
  }
  return out;
}
/** Shared normalized artifact is both the accurate preview and downloaded export. */
export async function renderNormalizedProject(
  input: NormalizedPlan,
  signal: AbortSignal,
  dir: string,
): Promise<RenderArtifact> {
  const plan = structuredClone(input);
  return withCancel(signal, async () => {
    throwIfCancelled();
    await mkdir(dir, { recursive: true });
    try {
      for (const asset of plan.assets)
        if ((await hash(asset.location)) !== asset.checksum)
          throw Error("Asset checksum changed since render request");
      for (const [name, file] of Object.entries(plan.fonts))
        if ((await hash(file)) !== plan.fontChecksums[name])
          throw Error("Local font changed since render request");
      const { document: doc, width: w, height: h } = plan;
      const filters: string[] = [];
      const args = ["-v", "error", "-nostdin", "-filter_complex_threads", "1"];
      let inputs = 0;
      args.push(
        "-f",
        "lavfi",
        "-i",
        `color=black:s=${w}x${h}:r=30:d=${plan.duration}`,
      );
      inputs++;
      filters.push("[0:v]format=yuv420p[base]");
      let base = "base",
        index = 0;
      const visuals = doc.items
        .filter(
          (i) => doc.tracks.find((t) => t.id === i.trackId)?.kind !== "audio",
        )
        .sort((a, b) => {
          const ta = doc.tracks.findIndex((t) => t.id === a.trackId),
            tb = doc.tracks.findIndex((t) => t.id === b.trackId);
          return (
            ta - tb ||
            (doc.tracks[ta]?.role === "overlay"
              ? 0
              : a.startFrame - b.startFrame)
          );
        });
      for (const item of visuals) {
        const asset = plan.assets.find((a) => a.id === item.assetId);
        if (!item.text && !asset) throw Error("Unresolved visual item");
        if (asset?.kind === "audio") throw Error("Audio asset on visual track");
        const duration = sec(item.durationFrames, doc),
          start = sec(item.startFrame, doc);
        const inputIndex = inputs++;
        if (item.text)
          args.push(
            "-f",
            "lavfi",
            "-i",
            `color=black@0:s=${w}x${h}:r=30:d=${duration},format=rgba`,
          );
        else if (asset!.kind === "image")
          args.push("-loop", "1", "-framerate", "30", "-i", asset!.location);
        else args.push("-i", asset!.location);
        const chain: string[] = [];
        if (!item.text && asset!.kind !== "image") {
          if (item.loop)
            throw Error(
              "Looping visual footage is not supported; loop its detached audio instead",
            );
          chain.push(
            "setpts=PTS-STARTPTS",
            `trim=end=${(item.sourceOutUs ?? 0) / 1e6}`,
            `setpts=(PTS-${(item.freeze?.sourceUs ?? (item.sourceInUs ?? 0) + numberUs(sourcePhaseUs(item))) / 1e6}/TB)/${item.speed}`,
            "fps=fps=30:start_time=0:round=near",
            ...(item.freeze ? ["trim=end_frame=1", "setpts=PTS-STARTPTS"] : []),
          );
        }
        chain.push(
          "fps=30",
          `tpad=stop_mode=clone:stop_duration=${duration}`,
          `trim=duration=${duration}`,
          "setpts=PTS-STARTPTS",
          // ffmpeg autorotation has already transposed pixels and inverted SAR.
          // Expand the appropriate axis before dropping SAR, then crop/fit in
          // square-pixel display coordinates. Even rounding is at most one pixel.
          "scale=w='ceil(iw*max(sar,1)/2)*2':h='ceil(ih/min(sar,1)/2)*2'",
          "setsar=1",
        );
        if (item.crop) {
          const c = item.crop;
          chain.push(`crop=iw*${c.width}:ih*${c.height}:iw*${c.x}:ih*${c.y}`);
        }
        chain.push(
          `scale=${w}:${h}:in_color_matrix=${asset ? plan.inputMatrices[asset.id] : "bt601"}:out_color_matrix=bt601:force_original_aspect_ratio=${item.fit === "cover" ? "increase" : "decrease"}:force_divisible_by=2`,
        );
        chain.push("format=rgba");
        chain.push(
          item.fit === "cover"
            ? `crop=${w}:${h}`
            : `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${doc.tracks.find((t) => t.id === item.trackId)?.role === "overlay" ? "black@0" : "black"}`,
        );
        chain.push("format=rgba");
        if (item.blur) chain.push(`gblur=sigma=${item.blur}`);
        if (item.colorPreset === "monochrome") chain.push("hue=s=0");
        if (item.colorPreset === "warm")
          chain.push("colorbalance=rs=.1:bs=-.08");
        if (item.colorPreset === "cool")
          chain.push("colorbalance=rs=-.08:bs=.1");
        if (item.text) {
          const textFile = path.join(dir, `text-${index}.txt`);
          await writeFile(textFile, item.text.value);
          chain.push(
            `drawtext=fontfile='${filterPath(plan.font)}':textfile='${filterPath(textFile)}':expansion=none:fontsize=${(item.text.fontSize * w) / doc.canvas.width}:fontcolor=${safeColor(item.text.color)}:x=(w-text_w)/2:y=(h-text_h)/2`,
          );
        }
        const fps = doc.fps.numerator / doc.fps.denominator;
        const scale = motionExpression(item, "scale", "t", fps),
          rotation = motionExpression(item, "rotation", "t", fps);
        if (item.keyframes || item.transform?.scale !== undefined)
          chain.push(
            `scale=w='max(2,trunc(iw*(${scale})/2)*2)':h='max(2,trunc(ih*(${scale})/2)*2)':eval=frame`,
          );
        if (item.keyframes) {
          // A fixed transparent surface prevents downstream filter negotiation
          // from stretching per-frame scaled dimensions back to the first size.
          const extent =
            Math.ceil(
              (Math.hypot(w, h) *
                Math.max(...item.keyframes.map((k) => k.scale))) /
                2,
            ) * 2;
          chain.push(
            `setsar=1,pad=${extent}:${extent}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame`,
          );
          chain.push(`rotate='(${rotation})*PI/180':ow=iw:oh=ih:c=none`);
        } else if (item.transform?.rotation)
          chain.push(
            `rotate=${rotation}*PI/180:ow=rotw(${rotation}*PI/180):oh=roth(${rotation}*PI/180):c=none`,
          );
        chain.push(`colorchannelmixer=aa=${item.opacity ?? 1}`);
        const previous = doc.items.find(
          (i) =>
            i.trackId === item.trackId &&
            i.transitionOut &&
            i.startFrame + i.durationFrames - i.transitionOut.durationFrames ===
              item.startFrame,
        );
        if (previous?.transitionOut)
          chain.push(
            `fade=t=in:st=0:d=${sec(previous.transitionOut.durationFrames, doc)}:alpha=1`,
          );
        chain.push(`setpts=PTS+${start}/TB`);
        filters.push(`[${inputIndex}:v]${chain.join(",")}[layer${index}]`);
        filters.push(
          `[${base}][layer${index}]overlay=x='(W-w)/2+${`(${motionExpression(item, "x", `(t-${start})`, fps)})*${w / doc.canvas.width}`}':y='(H-h)/2+${`(${motionExpression(item, "y", `(t-${start})`, fps)})*${h / doc.canvas.height}`}':eof_action=pass:repeatlast=0:enable='gte(t,${start})*lt(t,${start + duration})'[composite${index}]`,
        );
        base = `composite${index++}`;
      }
      for (const cue of doc.captionCues) {
        const textFile = path.join(dir, `caption-${index}.txt`);
        await writeFile(
          textFile,
          wrapCaption(
            cue.text,
            Math.max(
              1,
              Math.floor((doc.canvas.width * 0.8) / (cue.fontSize ?? 64)),
            ),
          ),
        );

        filters.push(
          `[${base}]drawtext=fontfile='${filterPath(plan.fonts[cue.fontFamily ?? "Arial"]!)}':textfile='${filterPath(textFile)}':expansion=none:fontsize=${((cue.fontSize ?? 64) * w) / doc.canvas.width}:fontcolor=${safeColor(cue.color ?? "#ffffff")}:shadowcolor=black:shadowx=1:shadowy=2:x=w*${cue.x ?? 0.5}-text_w/2:y=h*${cue.y ?? 0.8}-text_h/2:enable='gte(t,${sec(cue.startFrame, doc)})*lt(t,${sec(cue.startFrame + cue.durationFrames, doc)})'[caption${index}]`,
        );
        base = `caption${index++}`;
      }
      filters.push(
        `[${base}]scale=in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709[normalized]`,
      );
      base = "normalized";
      const audio = await mixAudio(plan, dir);
      const audioInput = inputs;
      args.push("-f", "f32le", "-ar", "48000", "-ac", "2", "-i", audio);
      const output = path.join(dir, "render.mp4");
      await run("ffmpeg", [
        ...args,
        "-filter_complex",
        filters.join(";"),
        "-map",
        `[${base}]`,
        "-map",
        `${audioInput}:a`,
        "-frames:v",
        String(plan.frameCount),
        "-t",
        String(plan.duration),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        "-y",
        output,
      ]);
      const probe = JSON.parse(
        (
          await run("ffprobe", [
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-of",
            "json",
            output,
          ])
        ).stdout,
      );
      const video = probe.streams.find((s: any) => s.codec_type === "video"),
        sound = probe.streams.find((s: any) => s.codec_type === "audio");
      if (
        Number(video?.nb_read_frames) !== plan.frameCount ||
        video.width !== w ||
        video.height !== h ||
        sound?.sample_rate !== "48000" ||
        Math.abs(Number(sound?.duration) - plan.duration) > 1 / 30
      )
        throw Error("Rendered media verification failed");
      const checksum = await hash(output);
      throwIfCancelled();
      return {
        id: randomUUID(),
        projectId: doc.id,
        revision: doc.revision,
        checksum,
        path: output,
        probe: {
          durationUs: Math.round(plan.duration * 1e6),
          width: w,
          height: h,
          fps: { numerator: 30, denominator: 1 },
          hasAudio: true,
        },
        renderer: "ffmpeg",
        rendererVersion: NORMALIZED_RENDERER_VERSION,
        reviewIds: [],
        preset: plan.preset,
        planHash: plan.planHash,
        normalizationPolicy: plan.normalizationPolicy,
        createdAt: Date.now(),
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  });
}
