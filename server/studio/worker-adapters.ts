import path from "node:path";
import { realpath } from "node:fs/promises";
import { run, ExecError } from "../../src/exec";
import { fetchSection } from "../../src/youtube";
import type { AssetRef } from "../../lib/studio/types";
import { runtimeStore } from "../db/runtime";
import { OUTPUT_ROOT } from "../paths";
import { registerWork } from "../worker/registry";
import type { StageContext, WorkStage } from "../worker/runner";
import { checksum, mediaUrl } from "./assets";
function assetFor(ctx: StageContext) {
  const id = ctx.lease.payload.assetId;
  if (typeof id !== "string")
    throw Object.assign(Error("Missing asset identity"), { retryable: false });
  const row = runtimeStore().get<AssetRef>("assets", id);
  if (!row)
    throw Object.assign(Error("Asset no longer exists"), { retryable: false });
  const root = path.resolve(OUTPUT_ROOT);
  if (!row.value.location.startsWith(root + path.sep))
    throw Object.assign(Error("Asset outside output folder"), {
      retryable: false,
    });
  return row;
}
async function probe(file: string, kind: AssetRef["kind"]) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    file,
  ]).catch((error) => {
    if (error instanceof ExecError)
      throw Object.assign(
        Error(`Unsupported or unreadable media: ${error.message}`),
        { retryable: false },
      );
    throw error;
  });
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: {
      codec_type: string;
      codec_name?: string;
      width?: number;
      height?: number;
      sample_rate?: string;
      duration?: string;
      side_data_list?: { rotation?: number }[];
      color_transfer?: string;
    }[];
  };
  if (
    data.streams?.some((stream) =>
      ["smpte2084", "arib-std-b67"].includes(stream.color_transfer ?? ""),
    )
  )
    throw Object.assign(
      Error(
        "HDR media needs tone mapping. Import an SDR copy for this preview.",
      ),
      { retryable: false },
    );
  const streams = (data.streams ?? [])
    .filter((s) => s.codec_type === "video" || s.codec_type === "audio")
    .map((s) => ({
      kind: s.codec_type as "video" | "audio",
      codec: s.codec_name ?? "unknown",
      width: s.width,
      height: s.height,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
    }));
  if (
    (kind === "video" && !streams.some((s) => s.kind === "video")) ||
    (kind === "audio" && !streams.some((s) => s.kind === "audio")) ||
    (kind === "image" && !streams.some((s) => s.kind === "video"))
  )
    throw Object.assign(Error("Unsupported media streams"), {
      retryable: false,
    });
  const durationUs =
    kind === "image"
      ? 5000000
      : Math.round(
          Number(data.format?.duration ?? data.streams?.[0]?.duration) *
            1000000,
        );
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0)
    throw Object.assign(Error("Unable to determine media duration"), {
      retryable: false,
    });
  return { streams, durationUs };
}
function prepareStages(): WorkStage[] {
  return [
    {
      name: "probe",
      run: async (ctx) => {
        const asset = assetFor(ctx).value;
        const actual = await realpath(asset.location);
        const root = await realpath(OUTPUT_ROOT);
        if (!actual.startsWith(root + path.sep))
          throw Object.assign(Error("Media resolves outside output folder"), {
            retryable: false,
          });
        if (asset.checksum && (await checksum(actual)) !== asset.checksum)
          throw Object.assign(
            Error("Original media changed. Import it as a new asset."),
            { retryable: false },
          );
        return { data: { probe: await probe(actual, asset.kind) } };
      },
    },
    {
      name: "proxy",
      expensive: true,
      run: async (ctx) => {
        const asset = assetFor(ctx).value;
        if (asset.kind !== "video" && asset.kind !== "audio") return;
        const suffix = asset.kind === "video" ? "mp4" : "m4a";
        const file = path.join(ctx.workspace, `proxy.${suffix}`);
        const destination = path.join(
          path.dirname(asset.location),
          `proxy.${suffix}`,
        );
        const args =
          asset.kind === "video"
            ? [
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-vf",
                "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
                "-r",
                "30",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "24",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-movflags",
                "+faststart",
              ]
            : ["-vn", "-c:a", "aac", "-ar", "48000"];
        await run("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          asset.location,
          ...args,
          file,
        ]);
        return {
          data: { proxyLocation: destination },
          artifacts: [{ from: file, to: destination }],
        };
      },
    },
    {
      name: "asset-ready",
      run: async (ctx) => {
        const row = assetFor(ctx);
        const data = ctx.data.probe as Pick<AssetRef, "durationUs" | "streams">;
        if (!data) throw Error("Missing durable probe result");
        ctx.fenced(() =>
          runtimeStore().save(
            "assets",
            row.id,
            {
              ...row.value,
              ...data,
              status: "ready",
              error: undefined,
              proxyLocation: ctx.data.proxyLocation,
              proxyUrl:
                typeof ctx.data.proxyLocation === "string"
                  ? mediaUrl(ctx.data.proxyLocation, OUTPUT_ROOT)
                  : undefined,
            },
            row.revision,
          ),
        );
      },
    },
  ];
}
export function registerStudioWorkers() {
  registerWork("asset-probe", () => prepareStages());
  registerWork("asset-proxy", () => prepareStages());
  registerWork("source-range", () => [
    {
      name: "fetch-range",
      expensive: true,
      run: async (ctx) => {
        const asset = assetFor(ctx).value;
        const request = asset.request;
        if (
          !request ||
          !/^[-_a-zA-Z0-9]{11}$/.test(request.videoId) ||
          !Number.isSafeInteger(request.startUs) ||
          request.startUs < 0 ||
          !Number.isSafeInteger(request.endUs) ||
          request.endUs <= request.startUs
        )
          throw Object.assign(Error("Invalid footage request"), {
            retryable: false,
          });
        const file = path.join(ctx.workspace, "source.mp4");
        await fetchSection(
          `https://www.youtube.com/watch?v=${request.videoId}`,
          request.startUs / 1000000,
          request.endUs / 1000000,
          file,
        );
        return {
          data: { sourceChecksum: await checksum(file) },
          artifacts: [{ from: file, to: asset.location }],
        };
      },
    },
    {
      name: "source-identity",
      run: async (ctx) => {
        const row = assetFor(ctx);
        ctx.fenced(() =>
          runtimeStore().save(
            "assets",
            row.id,
            {
              ...row.value,
              checksum: ctx.data.sourceChecksum,
              status: "probing",
            },
            row.revision,
          ),
        );
      },
    },
    ...prepareStages(),
  ]);
}
