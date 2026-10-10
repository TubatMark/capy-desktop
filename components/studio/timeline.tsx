"use client";
import { useRef, useState } from "react";
import type { AssetRef, ProjectDocument } from "@/lib/studio/types";
import type { EditOperation } from "@/lib/studio/operations";
import { cn } from "@/lib/utils";
export function snapFrame(frame: number, boundaries: number[], threshold = 3) {
  const nearest = boundaries.reduce(
    (best, candidate) =>
      Math.abs(candidate - frame) < Math.abs(best - frame) ? candidate : best,
    frame + threshold + 1,
  );
  return Math.abs(nearest - frame) <= threshold
    ? nearest
    : Math.max(0, Math.round(frame));
}
export function Timeline({
  document,
  assets,
  selected,
  frame,
  onSelect,
  onFrame,
  onEdit,
}: {
  document: ProjectDocument;
  assets: AssetRef[];
  selected?: string;
  frame: number;
  onSelect: (id: string) => void;
  onFrame: (n: number) => void;
  onEdit: (op: EditOperation) => void;
}) {
  const [zoom, setZoom] = useState(2);
  const [snap, setSnap] = useState(true);
  const drag = useRef<{ id: string; x: number; start: number } | null>(null);
  const total = Math.max(
    300,
    ...document.items.map((i) => i.startFrame + i.durationFrames),
  );
  const fps = document.fps.numerator / document.fps.denominator;
  return (
    <section
      className="min-w-0 rounded-xl border bg-card p-4"
      aria-label="Project timeline"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">
          Timeline{" "}
          <span className="ml-2 font-mono font-normal text-muted-foreground">
            {frame}f · {(frame / fps).toFixed(2)}s
          </span>
        </h2>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={snap}
              onChange={(e) => setSnap(e.target.checked)}
            />{" "}
            Snap to edges
          </label>
          <label className="flex items-center gap-2">
            Zoom
            <input
              aria-label="Timeline zoom"
              type="range"
              min="0.5"
              max="8"
              step="0.5"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
        </div>
      </div>
      <div className="overflow-x-auto pb-3">
        <div
          className="relative"
          style={{ width: Math.max(700, total * zoom + 80) }}
        >
          <div
            className="relative ml-20 h-8 cursor-crosshair border-b"
            onClick={(e) =>
              onFrame(
                Math.max(
                  0,
                  Math.round(
                    (e.clientX - e.currentTarget.getBoundingClientRect().left) /
                      zoom,
                  ),
                ),
              )
            }
            aria-label="Timeline ruler"
          >
            {Array.from({ length: Math.floor(total / 30) + 1 }, (_, i) => (
              <span
                key={i}
                className="absolute border-l pl-1 font-mono text-[10px] text-muted-foreground"
                style={{ left: i * 30 * zoom }}
              >
                {((i * 30) / fps).toFixed(1)}s
              </span>
            ))}
          </div>
          {document.tracks.map((track) => (
            <div key={track.id} className="flex h-20 border-b last:border-b-0">
              <span className="flex w-20 shrink-0 items-center text-xs capitalize text-muted-foreground">
                {track.kind}
              </span>
              <div className="relative flex-1 bg-muted/20">
                {document.items
                  .filter((i) => i.trackId === track.id)
                  .map((item) => {
                    const asset = assets.find((a) => a.id === item.assetId);
                    return (
                      <button
                        key={item.id}
                        data-testid="timeline-item"
                        aria-label={`Clip ${asset?.name ?? item.text?.value ?? item.id}`}
                        aria-pressed={selected === item.id}
                        className={cn(
                          "absolute top-2 h-16 touch-none overflow-hidden rounded-lg border px-2 text-left text-xs select-none",
                          selected === item.id
                            ? "border-primary bg-primary/15 ring-2 ring-primary/40"
                            : "border-border bg-accent",
                          asset?.status !== "ready" && "border-dashed",
                        )}
                        style={{
                          left: item.startFrame * zoom,
                          width: Math.max(22, item.durationFrames * zoom),
                        }}
                        onClick={() => {
                          onSelect(item.id);
                          onFrame(item.startFrame);
                        }}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          onSelect(item.id);
                          drag.current = {
                            id: item.id,
                            x: e.clientX,
                            start: item.startFrame,
                          };
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerUp={(e) => {
                          const initial = drag.current;
                          drag.current = null;
                          if (!initial || initial.id !== item.id) return;
                          const delta = (e.clientX - initial.x) / zoom;
                          if (Math.abs(delta) < 2) return;
                          const proposed = Math.max(
                            0,
                            Math.round(initial.start + delta),
                          );
                          const boundaries = [
                            0,
                            ...document.items
                              .filter(
                                (i) =>
                                  i.id !== item.id && i.trackId === track.id,
                              )
                              .flatMap((i) => [
                                i.startFrame,
                                i.startFrame + i.durationFrames,
                              ]),
                          ];
                          const start = snap
                            ? snapFrame(
                                proposed,
                                boundaries,
                                Math.max(2, Math.round(6 / zoom)),
                              )
                            : proposed;
                          onEdit({
                            type: "move",
                            itemId: item.id,
                            startFrame: start,
                          });
                        }}
                      >
                        <span className="block truncate font-medium">
                          {asset?.name ?? item.text?.value ?? "Clip"}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">
                          {item.durationFrames}f · {asset?.status ?? "text"}
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-primary"
            style={{ left: 80 + frame * zoom }}
          >
            <span className="absolute top-0 -translate-x-1/2 rounded-sm bg-primary px-1 text-[9px] text-primary-foreground">
              ▼
            </span>
          </div>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Drag a clip to move it. Edges snap within 6 pixels. S splits at the
        playhead; Delete removes the selected clip.
      </p>
    </section>
  );
}
