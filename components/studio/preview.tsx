"use client";
import { useRef, useState } from "react";
import type { RenderArtifact } from "@/lib/studio/types";
export type PreviewArtifact = Omit<RenderArtifact, "path"> & {
  url: string;
  current: boolean;
};
/** This transport decodes the exact immutable downloaded bytes, including the mixed audio. */
export function NormalizedPreview({ artifact }: { artifact: PreviewArtifact }) {
  const video = useRef<HTMLVideoElement>(null),
    [frame, setFrame] = useState(0);
  const count = Math.round(
    (artifact.probe.durationUs * artifact.probe.fps.numerator) /
      (1e6 * artifact.probe.fps.denominator),
  );
  const seek = (n: number) => {
    const next = Math.max(0, Math.min(count - 1, n));
    setFrame(next);
    if (video.current) {
      video.current.pause();
      video.current.currentTime =
        (next * artifact.probe.fps.denominator) / artifact.probe.fps.numerator;
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-sm">
        Rendered preview · revision {artifact.revision}
        {!artifact.current && " · earlier revision"}
      </p>
      <video
        data-testid="normalized-preview"
        key={artifact.id}
        ref={video}
        src={artifact.url}
        controls
        playsInline
        preload="metadata"
        className="mx-auto max-h-96 max-w-full rounded-lg bg-black"
        onTimeUpdate={() =>
          setFrame(
            Math.min(
              count - 1,
              Math.round(
                ((video.current?.currentTime ?? 0) *
                  artifact.probe.fps.numerator) /
                  artifact.probe.fps.denominator,
              ),
            ),
          )
        }
      />
      <div className="flex gap-2 items-center">
        <button
          aria-label="Rendered previous frame"
          onClick={() => seek(frame - 1)}
        >
          −1
        </button>
        <input
          aria-label="Rendered preview frame"
          type="range"
          min={0}
          max={Math.max(0, count - 1)}
          value={frame}
          onChange={(e) => seek(Number(e.target.value))}
          className="grow"
        />
        <button
          aria-label="Rendered next frame"
          onClick={() => seek(frame + 1)}
        >
          +1
        </button>
        <span className="text-xs">
          {frame}/{count - 1}
        </span>
      </div>
    </div>
  );
}
