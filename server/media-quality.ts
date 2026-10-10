import { createHash } from "node:crypto";
import { statSync, createReadStream } from "node:fs";
import { escapeFilterPath } from "../src/render";
import { run } from "../src/exec";
import type { RenderArtifact } from "../lib/studio/types";
import type { MediaQualityReport } from "../lib/creator-policy";
import { runtimeStore } from "./db/runtime";
import { fence } from "./worker/context";
export interface MediaCheckPolicy {
  aspect?: "portrait" | "landscape" | "square";
  requireAudio?: boolean;
  requireModelReview?: boolean;
  captions?: { x: number; y: number; width: number; height: number }[];
  safeInset?: number;
  captionOverlayPath?: string;
  maxBlackRatio?: number;
  maxFrozenRatio?: number;
}
async function digest(file: string) {
  const h = createHash("sha256");
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest("hex");
}
/** Decode actual media locally. No face/speech classifier or model is an admission shortcut. */
export async function checkMedia(
  artifact: RenderArtifact,
  policy: MediaCheckPolicy = {},
): Promise<MediaQualityReport> {
  const checks: MediaQualityReport["checks"] = [];
  const add = (id: string, pass: boolean, reason: string, measured?: number) =>
    checks.push({ id, pass, reason, measured });
  const modelReview: MediaQualityReport["modelReview"] =
    policy.requireModelReview
      ? {
          status: "unavailable",
          reason:
            "Supplementary content review must run through the bounded AI router or wait for a person",
        }
      : {
          status: "not_requested",
          reason:
            "Technical checks use deterministic local decoding; no model call requested",
        };
  const report = (): MediaQualityReport => ({
    artifactId: artifact.id,
    checksum: artifact.checksum,
    revision: artifact.revision,
    reviewVersion: "deterministic-media-v1",
    policy: {
      requireAudio: !!policy.requireAudio,
      aspect: policy.aspect ?? artifact.preset?.aspect,
      maxBlackRatio: policy.maxBlackRatio ?? 0.9,
      maxFrozenRatio: policy.maxFrozenRatio,
    },
    at: Date.now(),
    passed: checks.every((c) => c.pass) && !policy.requireModelReview,
    checks,
    modelReview,
  });
  try {
    if (statSync(artifact.path).size > 4 * 1024 ** 3)
      throw Error("Media exceeds the 4-GB bounded quality-check size");
    const hash = await digest(artifact.path);
    add(
      "identity",
      hash === artifact.checksum,
      "Rendered file checksum must match its immutable artifact",
    );
    const { stdout } = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        artifact.path,
      ],
      { timeoutMs: 30000 },
    );
    const probe = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type: string; width?: number; height?: number }[];
    };
    const video = probe.streams?.find((s) => s.codec_type === "video");
    const audio = probe.streams?.some((s) => s.codec_type === "audio");
    const duration = Number(probe.format?.duration),
      width = video?.width ?? 0,
      height = video?.height ?? 0;
    add(
      "duration",
      Number.isFinite(duration) &&
        duration > 0 &&
        duration <= 1800 &&
        Math.abs(duration - artifact.probe.durationUs / 1e6) < 0.15,
      "Decoded duration must match the artifact within 150 ms and fit the 30-minute quality-check limit",
      duration,
    );
    if (!video || !width || !height) throw Error("No decodable video stream");
    if (duration > 1800)
      throw Error("Media exceeds bounded quality-check duration");
    const aspect = policy.aspect ?? artifact.preset?.aspect;
    const target =
      aspect === "portrait"
        ? 9 / 16
        : aspect === "landscape"
          ? 16 / 9
          : aspect === "square"
            ? 1
            : undefined;
    add(
      "aspect",
      !target || Math.abs(width / height - target) < 0.015,
      "Rendered aspect must match the selected destination recipe",
      width / height,
    );
    const { stderr } = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "info",
        "-xerror",
        "-err_detect",
        "explode",
        "-i",
        artifact.path,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        "blackdetect=d=0.05:pix_th=0.1,freezedetect=n=-60dB:d=0.1",
        ...(audio ? ["-af", "silencedetect=n=-50dB:d=0.05"] : []),
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 120000 },
    );
    add(
      "decode",
      true,
      "Entire media decoded without truncation or stream errors",
    );
    const black =
      [...stderr.matchAll(/black_duration:([\d.]+)/g)].reduce(
        (n, m) => n + Number(m[1]),
        0,
      ) / duration;
    add(
      "black",
      black <= (policy.maxBlackRatio ?? 0.9),
      "Black frames exceed the configured maximum fraction",
      black,
    );
    let silence = 0;
    let open: number | undefined;
    for (const match of stderr.matchAll(/silence_(start|end): ([\d.]+)/g)) {
      if (match[1] === "start") open = Number(match[2]);
      else if (open !== undefined) {
        silence += Number(match[2]) - open;
        open = undefined;
      }
    }
    if (open !== undefined) silence += duration - open;
    const silenceRatio = audio ? Math.min(1, silence / duration) : 1;
    add(
      "audio",
      !policy.requireAudio || (!!audio && silenceRatio < 0.95),
      "Creator audio policy requires audible sound; silent footage is allowed when audio is optional",
      silenceRatio,
    );
    let frozenSeconds = 0;
    let freezeOpen: number | undefined;
    for (const match of stderr.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
      if (match[1] === "start") freezeOpen = Number(match[2]);
      else if (freezeOpen !== undefined) {
        frozenSeconds += Number(match[2]) - freezeOpen;
        freezeOpen = undefined;
      }
    }
    if (freezeOpen !== undefined) frozenSeconds += duration - freezeOpen;
    const frozen = Math.min(1, Math.max(0, frozenSeconds / duration));
    add(
      "frozen",
      policy.maxFrozenRatio === undefined || frozen <= policy.maxFrozenRatio,
      "Frozen-frame fraction exceeds the explicitly configured limit",
      frozen,
    );
    const inset = policy.safeInset ?? 0.05;
    const captions = policy.captions ?? [];
    let overlaySafe = true;
    if (policy.captionOverlayPath) {
      const filter = `ass=filename='${escapeFilterPath(policy.captionOverlayPath)}',drawbox=x=${Math.ceil(width * inset)}:y=${Math.ceil(height * inset)}:w=${Math.floor(width * (1 - 2 * inset))}:h=${Math.floor(height * (1 - 2 * inset))}:color=black:t=fill,blackdetect=d=0.01:pix_th=0.03:pic_th=1`;
      const mask = await run(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostdin",
          "-v",
          "info",
          "-f",
          "lavfi",
          "-i",
          `color=c=black:s=${width}x${height}:r=30:d=${duration}`,
          "-vf",
          filter,
          "-f",
          "null",
          "-",
        ],
        { timeoutMs: 120000 },
      );
      const blackDuration = [
        ...mask.stderr.matchAll(/black_duration:([\d.]+)/g),
      ].reduce((n, m) => n + Number(m[1]), 0);
      overlaySafe = blackDuration >= duration - 2 / 30;
    }
    add(
      "captions",
      overlaySafe &&
        captions.every(
          (c) =>
            [c.x, c.y, c.width, c.height].every(Number.isFinite) &&
            c.width > 0 &&
            c.height > 0 &&
            c.x >= width * inset &&
            c.y >= height * inset &&
            c.x + c.width <= width * (1 - inset) &&
            c.y + c.height <= height * (1 - inset),
        ),
      "Caption bounds must remain inside the configured rendered safe area",
    );
  } catch (error) {
    add(
      checks.some((c) => c.id === "decode") ? "captions" : "decode",
      false,
      `Media could not decode safely: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
  return report();
}
export async function recordMediaQuality(
  artifact: RenderArtifact,
  policy: MediaCheckPolicy = {},
) {
  const report = await checkMedia(artifact, policy);
  fence(() => {
    const store = runtimeStore();
    store.put("media-quality", artifact.checksum, report);
    store.put("automation-decisions", `quality:${artifact.id}`, {
      candidateId: artifact.id,
      kind: report.passed ? "proceed" : "defer",
      reason: report.passed
        ? "Decoded media passed all current technical checks"
        : report.checks
            .filter((check) => !check.pass)
            .map((check) => check.reason)
            .join("; ") || report.modelReview.reason,
      at: report.at,
    });
  });
  return report;
}

/** The existing A4-routed reviewer is supplementary to decoded technical checks. */
export function recordSupplementaryReview(
  checksum: string,
  review: import("../lib/types").ContentReview,
) {
  fence(() => {
    const store = runtimeStore(),
      report = store.get<MediaQualityReport>("media-quality", checksum)?.value;
    if (!report) return;
    store.put("automation-decisions", `review:${report.artifactId}`, {
      candidateId: report.artifactId,
      kind: review.verdict === "ok" ? "proceed" : "defer",
      reason: review.summary || "Supplementary review needs attention",
      at: review.at,
    });
    store.put("media-quality", checksum, {
      ...report,
      supplementaryReview: structuredClone(review),
      modelReview: {
        status:
          review.verdict === "ok"
            ? "passed"
            : review.verdict === "block"
              ? "blocked"
              : review.summary.startsWith("AI review unavailable:")
                ? "unavailable"
                : "needs_review",
        reason: review.summary,
      },
    });
  });
}
