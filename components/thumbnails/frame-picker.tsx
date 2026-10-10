"use client";
import { useState } from "react";
import type { FrameCandidate } from "@/lib/thumbnails";
export function FramePicker({
  frames,
  selected,
  onSelect,
  onExtract,
  busy,
}: {
  frames: FrameCandidate[];
  selected?: string;
  onSelect: (frame: FrameCandidate) => void;
  onExtract: (timeUs?: number, kind?: "clean" | "finished") => void;
  busy: boolean;
}) {
  const [seconds, setSeconds] = useState("0"),
    [kind, setKind] = useState<"clean" | "finished">("clean");
  return (
    <section className="space-y-3" aria-label="Source frames">
      <h2 className="font-semibold">Source frame</h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          Frame time (seconds)
          <input
            type="number"
            min="0"
            step="0.01"
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
            className="block w-28 rounded border p-2"
          />
        </label>
        <label className="text-sm">
          Frame source
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className="block rounded border p-2"
          >
            <option value="clean">Original footage</option>
            <option value="finished">Finished edit</option>
          </select>
        </label>
        <button
          disabled={busy}
          onClick={() => onExtract(Math.round(Number(seconds) * 1000000), kind)}
          className="rounded border p-2"
        >
          Extract selected frame
        </button>
        <button
          disabled={busy}
          onClick={() => onExtract()}
          className="rounded border p-2"
        >
          Suggest frames
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {frames.map((frame) => (
          <button
            key={frame.id}
            onClick={() => onSelect(frame)}
            disabled={busy}
            aria-pressed={selected === frame.id}
            className={`rounded border p-1 ${selected === frame.id ? "ring-2 ring-primary" : ""}`}
          >
            <img
              src={frame.path}
              alt={`Source at ${(frame.sourceUs / 1000000).toFixed(2)} seconds`}
              className="h-20 w-full object-contain"
            />
            <span className="text-xs">
              {(frame.renderUs / 1000000).toFixed(2)}s · {frame.frameKind}
            </span>
            {frame.quality.reason && (
              <span className="block text-xs">{frame.quality.reason}</span>
            )}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        The source image stays separate from the background. Frame replacement
        and crop are local edits.
      </p>
    </section>
  );
}
