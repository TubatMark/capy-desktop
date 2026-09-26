"use client";
import { useCallback, useRef } from "react";
import { fmtTime } from "@/lib/utils";
import type { Word } from "@/lib/types";

/**
 * Range track over the padded segment: dark = outside the clip, bright = the clip.
 * Drag the edges to trim, click anywhere to move the playhead.
 * All times are absolute seconds in the source video.
 */
export function Timeline({
  segStart,
  segEnd,
  start,
  end,
  playhead,
  words,
  onChange,
  onSeek,
}: {
  segStart: number;
  segEnd: number;
  start: number;
  end: number;
  playhead: number;
  words: Word[];
  onChange: (start: number, end: number, commit: boolean) => void;
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const span = Math.max(0.01, segEnd - segStart);
  const pct = (t: number) => ((t - segStart) / span) * 100;
  const toTime = useCallback(
    (clientX: number) => {
      const r = ref.current!.getBoundingClientRect();
      return segStart + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
    },
    [segStart, span],
  );

  function drag(which: "start" | "end" | "seek") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const t = toTime(ev.clientX);
        if (which === "start") onChange(Math.min(t, end - 3), end, false);
        else if (which === "end") onChange(start, Math.max(t, start + 3), false);
        else onSeek(t);
      };
      const up = (ev: PointerEvent) => {
        const t = toTime(ev.clientX);
        if (which === "start") onChange(Math.min(t, end - 3), end, true);
        else if (which === "end") onChange(start, Math.max(t, start + 3), true);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      if (which === "seek") onSeek(toTime(e.clientX));
    };
  }

  // speech density strip: one bar per word
  const bars = words.filter((w) => w.end > segStart && w.start < segEnd);

  return (
    <div className="min-w-0 select-none">
      <div className="mb-1 flex justify-between gap-2 font-mono text-[11px] text-muted-foreground">
        <span className="shrink-0">{fmtTime(segStart)}</span>
        <span className="min-w-0 truncate text-center">
          in {fmtTime(start)} · out {fmtTime(end)} · {Math.round(end - start)}s
        </span>
        <span className="shrink-0">{fmtTime(segEnd)}</span>
      </div>
      <div ref={ref} className="relative h-16 cursor-crosshair rounded-lg border bg-neutral-900" onPointerDown={drag("seek")}>
        {/* word bars */}
        <div className="absolute inset-x-0 bottom-0 top-6">
          {bars.map((w, i) => (
            <div
              key={i}
              className="absolute bottom-1 top-1 rounded-sm bg-white/25"
              style={{ left: `${pct(Math.max(w.start, segStart))}%`, width: `${Math.max(0.15, pct(Math.min(w.end, segEnd)) - pct(Math.max(w.start, segStart)))}%` }}
            />
          ))}
        </div>
        {/* dimmed outside */}
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/60" style={{ width: `${pct(start)}%` }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/60" style={{ width: `${100 - pct(end)}%` }} />
        {/* clip band */}
        <div className="pointer-events-none absolute inset-y-0 border-y-2 border-primary" style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }} />
        {/* handles */}
        {/* handles: wider below md so they can be grabbed on touch / in a small window */}
        <div
          className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize rounded-l-md bg-primary hover:bg-primary/80 max-md:w-5"
          style={{ left: `${pct(start)}%` }}
          onPointerDown={drag("start")}
          title="Drag to set in point"
        />
        <div
          className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize rounded-r-md bg-primary hover:bg-primary/80 max-md:w-5"
          style={{ left: `${pct(end)}%` }}
          onPointerDown={drag("end")}
          title="Drag to set out point"
        />
        {/* playhead */}
        <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white" style={{ left: `${pct(playhead)}%` }}>
          <div className="absolute -top-1 left-1/2 size-2.5 -translate-x-1/2 rotate-45 bg-white" />
        </div>
      </div>
    </div>
  );
}
