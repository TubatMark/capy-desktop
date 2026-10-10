"use client";
import { useEffect, useRef } from "react";
import type {
  AssetRef,
  ProjectDocument,
  TimelineItem,
} from "@/lib/studio/types";
import { visualTransform } from "@/lib/studio/visual";
import { sourceTimeUs } from "@/lib/studio/audio";
import { StudioCaptionOverlay } from "@/components/caption-overlay";
function LayerMedia({
  item,
  asset,
  document,
  frame,
  playing,
}: {
  item: TimelineItem;
  asset: AssetRef;
  document: ProjectDocument;
  frame: number;
  playing: boolean;
}) {
  const media = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = media.current;
    if (!video) return;
    const desired = sourceTimeUs(item, frame, document) / 1000000;
    if (Math.abs(video.currentTime - desired) > 0.05)
      video.currentTime = desired;
    if (playing && video.paused) void video.play().catch(() => {});
    else if (!playing) video.pause();
  }, [item, document, frame, playing]);
  const style = { objectFit: item.fit ?? "contain" } as const;
  return asset.kind === "image" ? (
    <img
      src={asset.mediaUrl}
      alt={asset.name ?? "Image overlay"}
      className="h-full w-full"
      style={style}
    />
  ) : (
    <video
      ref={media}
      src={asset.proxyUrl ?? asset.mediaUrl}
      muted
      playsInline
      className="h-full w-full"
      style={style}
    />
  );
}
export function LayerPreview({
  document,
  assets,
  frame,
  playing,
  main,
}: {
  document: ProjectDocument;
  assets: AssetRef[];
  frame: number;
  playing: boolean;
  main?: TimelineItem;
}) {
  const layers = document.items.filter(
    (i) =>
      document.tracks.find((t) => t.id === i.trackId)?.role === "overlay" &&
      frame >= i.startFrame &&
      frame < i.startFrame + i.durationFrames,
  );
  const transition = main?.transitionOut;
  const next = transition
    ? document.items.find(
        (i) =>
          i.trackId === main!.trackId &&
          i.id !== main!.id &&
          i.startFrame ===
            main!.startFrame + main!.durationFrames - transition.durationFrames,
      )
    : undefined;
  const progress = next
    ? Math.max(
        0,
        Math.min(1, (frame - next.startFrame) / transition!.durationFrames),
      )
    : 0;
  const incoming = assets.find((a) => a.id === next?.assetId);
  return (
    <>
      {next && incoming?.status === "ready" && progress > 0 && (
        <div
          className="absolute inset-0"
          style={{
            opacity: progress,
            transform: visualTransform(next, document.canvas),
          }}
        >
          <LayerMedia
            item={next}
            asset={incoming}
            document={document}
            frame={frame}
            playing={playing}
          />
        </div>
      )}
      {layers.map((item) => {
        const asset = assets.find((a) => a.id === item.assetId);
        return (
          <div
            data-testid="preview-layer"
            key={item.id}
            className="absolute inset-0 flex items-center justify-center"
            style={{
              opacity: item.opacity ?? 1,
              transform: visualTransform(item, document.canvas),
            }}
          >
            {item.text ? (
              <p
                className="whitespace-pre-wrap text-center"
                style={{
                  fontSize: `${(item.text.fontSize / document.canvas.width) * 100}cqw`,
                  color: item.text.color,
                }}
              >
                {item.text.value}
              </p>
            ) : asset?.status === "ready" ? (
              <LayerMedia
                item={item}
                asset={asset}
                document={document}
                frame={frame}
                playing={playing}
              />
            ) : (
              <span className="text-xs text-white">
                Overlay media unavailable
              </span>
            )}
          </div>
        );
      })}
      <StudioCaptionOverlay
        cues={document.captionCues}
        frame={frame}
        width={document.canvas.width}
      />
      {document.safeArea?.enabled && (
        <div
          data-testid="preview-safe-area"
          className="pointer-events-none absolute border border-dashed border-yellow-300/80"
          style={{ inset: `${document.safeArea.inset * 100}%` }}
        />
      )}
    </>
  );
}
