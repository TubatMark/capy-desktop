import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { run } from "../../../src/exec";
import type {
  AssetRef,
  ProjectDocument,
  TimelineItem,
} from "../../../lib/studio/types";
export async function syntheticStudio(dir: string, kind: "mixed60" | "rich30") {
  await mkdir(dir, { recursive: true });
  const assets: AssetRef[] = [];
  const add = async (
    id: string,
    args: string[],
    duration: number,
    mediaKind: AssetRef["kind"] = "video",
  ) => {
    const file = path.join(
      dir,
      `${id}.${mediaKind === "audio" ? "wav" : "mp4"}`,
    );
    await run("ffmpeg", ["-v", "error", ...args, "-y", file]);
    const a: AssetRef = {
      id,
      kind: mediaKind,
      location: file,
      durationUs: duration * 1e6,
      checksum: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
      status: "ready",
    };
    assets.push(a);
    return a;
  };
  const colors = ["red", "green", "blue", "yellow"],
    rates = ["24", "25", "60", "30000/1001"];
  const rich = kind === "rich30",
    durations = rich ? [11, 11, 10] : [15, 15, 15, 15];
  for (let i = 0; i < durations.length; i++) {
    const d = durations[i]!;
    const args = [
      "-f",
      "lavfi",
      "-i",
      `color=${colors[i]}:s=320x180:r=${rates[i]}:d=${d}`,
    ];
    if (!rich && i !== 1)
      args.push(
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${300 + i * 200}:sample_rate=${i === 0 ? 44100 : 48000}:duration=${d}`,
      );
    args.push("-c:v", "libx264", "-preset", "ultrafast");
    if (!rich && i !== 1) args.push("-c:a", "aac", "-shortest");
    const a = await add(`v${i}`, args, d);
    if (i === 1 && !rich) {
      const rotated = path.join(dir, "rotated.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-display_rotation",
        "90",
        "-i",
        a.location,
        "-c",
        "copy",
        "-y",
        rotated,
      ]);
      const probe = JSON.parse(
        (
          await run("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "stream_side_data",
            "-of",
            "json",
            rotated,
          ])
        ).stdout,
      );
      if (probe.streams[0]?.side_data_list?.[0]?.rotation !== 90)
        throw Error("Rotation fixture metadata missing");
      a.location = rotated;
      a.checksum = createHash("sha256")
        .update(await readFile(rotated))
        .digest("hex");
    }
  }
  const items: TimelineItem[] = durations.map((d, i) => ({
    id: `clip${i}`,
    trackId: "video",
    assetId: `v${i}`,
    startFrame: rich ? i * 300 : i * 450,
    durationFrames: d * 30,
    sourceInUs: 0,
    sourceOutUs: d * 1e6,
    speed: 1,
    ...(rich && i < 2
      ? { transitionOut: { kind: "crossfade" as const, durationFrames: 30 } }
      : {}),
  }));
  if (rich) {
    await add(
      "music",
      [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:sample_rate=44100:duration=30",
        "-c:a",
        "pcm_s16le",
      ],
      30,
      "audio",
    );
    await add(
      "voice",
      [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000:duration=5",
        "-c:a",
        "pcm_s16le",
      ],
      5,
      "audio",
    );
    items.push(
      {
        id: "music",
        trackId: "audio",
        assetId: "music",
        startFrame: 0,
        durationFrames: 900,
        sourceInUs: 0,
        sourceOutUs: 30e6,
        speed: 1,
        audioRole: "music",
        ducking: {
          enabled: true,
          reductionDb: 12,
          attackMs: 100,
          releaseMs: 300,
        },
      },
      {
        id: "voice",
        trackId: "audio",
        assetId: "voice",
        startFrame: 300,
        durationFrames: 150,
        sourceInUs: 0,
        sourceOutUs: 5e6,
        speed: 1,
        audioRole: "voiceover",
      },
      {
        id: "title",
        trackId: "text",
        startFrame: 0,
        durationFrames: 900,
        speed: 1,
        text: {
          value: "B1 normalized rich edit",
          fontSize: 42,
          color: "#ffffff",
        },
        transform: { x: 0, y: -650, scale: 1, rotation: 0 },
      },
    );
  } else {
    const expr = [0.2, 14.2, 29.2, 44.2, 59.2]
      .map((t) => `between(t,${t},${t + 0.1})`)
      .join("+");
    await add(
      "markers",
      [
        "-f",
        "lavfi",
        "-i",
        `aevalsrc='0.5*sin(2*PI*3000*t)*(${expr})':s=44100:d=60`,
        "-c:a",
        "pcm_s16le",
      ],
      60,
      "audio",
    );
    items.push({
      id: "markers",
      trackId: "audio",
      assetId: "markers",
      startFrame: 0,
      durationFrames: 1800,
      sourceInUs: 0,
      sourceOutUs: 60e6,
      speed: 1,
      audioRole: "sfx",
    });
  }
  const document: ProjectDocument = {
    schemaVersion: 1,
    id: kind,
    revision: 1,
    name: kind,
    canvas: { width: 1080, height: 1920 },
    fps: { numerator: 30, denominator: 1 },
    tracks: [
      { id: "video", kind: "video" },
      { id: "audio", kind: "audio" },
      { id: "text", kind: "text", role: "overlay" },
    ],
    items,
    sourceMappings: items
      .filter((i) => i.assetId)
      .map((i) => ({
        itemId: i.id,
        assetId: i.assetId!,
        sourceInUs: i.sourceInUs!,
        sourceOutUs: i.sourceOutUs!,
      })),
    captionCues: [
      {
        id: "c",
        startFrame: rich ? 300 : 450,
        durationFrames: rich ? 150 : 30,
        text: "Frame accurate caption",
        fontSize: 64,
      },
    ],
    thumbnailIds: [],
  };
  return { document, assets };
}
export function toneAmplitude(
  bytes: Buffer,
  start: number,
  duration: number,
  hz: number,
  rate = 48000,
) {
  let re = 0,
    im = 0;
  const begin = Math.round(start * rate),
    n = Math.round(duration * rate);
  for (let i = 0; i < n; i++) {
    const sample = bytes.readFloatLE((begin + i) * 4),
      phase = (2 * Math.PI * hz * i) / rate;
    re += sample * Math.cos(phase);
    im += sample * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / n;
}
