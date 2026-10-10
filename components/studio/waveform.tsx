"use client";
import { useEffect, useState } from "react";
import type {
  AssetRef,
  ProjectDocument,
  TimelineItem,
} from "@/lib/studio/types";
import { waveformPeaks, sourceTimeUs } from "@/lib/studio/audio";
const cache = new Map<string, Promise<number[]>>();
async function decode(asset: AssetRef): Promise<number[]> {
  const context = new AudioContext();
  try {
    const response = await fetch(asset.mediaUrl!);
    if (!response.ok) throw Error("Cannot load waveform");
    if (Number(response.headers.get("content-length")) > 64 * 1024 * 1024)
      throw Error("Waveform source exceeds browser decode limit");
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    return waveformPeaks(
      Array.from({ length: buffer.numberOfChannels }, (_, i) =>
        buffer.getChannelData(i),
      ),
    );
  } finally {
    await context.close();
  }
}
export function Waveform({
  asset,
  item,
  document,
}: {
  asset: AssetRef;
  item: TimelineItem;
  document: ProjectDocument;
}) {
  const [peaks, setPeaks] = useState<number[]>(),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const key = `${asset.id}:${asset.checksum}`;
    if (!cache.has(key)) cache.set(key, decode(asset));
    void cache.get(key)!.then(
      (value) => {
        if (live) setPeaks(value);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [asset.id, asset.checksum]);
  if (!peaks)
    return (
      <span className="text-[9px] text-muted-foreground">
        {failed ? "Waveform unavailable" : "Reading waveform…"}
      </span>
    );
  const mapped = Array.from({ length: 96 }, (_, bin) => {
    const time = sourceTimeUs(
      item,
      item.startFrame + (bin * item.durationFrames) / 96,
      document,
    );
    const index = Math.min(
      peaks.length - 1,
      Math.max(
        0,
        Math.floor(
          (time / (asset.durationUs ?? item.sourceOutUs!)) * peaks.length,
        ),
      ),
    );
    return peaks[index] ?? 0;
  });
  return (
    <svg
      data-testid="audio-waveform"
      viewBox="0 0 96 20"
      preserveAspectRatio="none"
      className="h-5 w-full"
      aria-label="Audio waveform"
    >
      {mapped.map((peak, i) => (
        <line
          key={i}
          x1={i}
          x2={i}
          y1={10 - peak * 10}
          y2={10 + peak * 10}
          stroke="currentColor"
          strokeWidth="0.7"
        />
      ))}
    </svg>
  );
}
