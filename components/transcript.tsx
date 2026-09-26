"use client";
import { useEffect, useRef } from "react";
import type { Word } from "@/lib/types";

/**
 * Words of the padded segment. Inside the clip = bright, current word = highlighted.
 * Click a word to move the playhead there; then press I / O (or the buttons) to trim.
 */
export function Transcript({ words, start, end, playhead, onSeek }: { words: Word[]; start: number; end: number; playhead: number; onSeek: (t: number) => void }) {
  const curRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    curRef.current?.scrollIntoView({ block: "nearest" });
  }, [playhead]);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden break-words rounded-lg border bg-neutral-950/60 p-3 text-[15px] leading-7">
      {words.map((w, i) => {
        const inside = w.start >= start - 0.05 && w.start < end;
        const cur = playhead >= w.start && playhead < (words[i + 1]?.start ?? w.end);
        return (
          <span
            key={i}
            ref={cur ? curRef : undefined}
            className={
              "cursor-pointer rounded px-0.5 transition-colors " +
              (cur ? "bg-primary text-primary-foreground" : inside ? "text-foreground hover:bg-accent" : "text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground")
            }
            onClick={() => onSeek(w.start)}
            title={`${w.start.toFixed(1)}s — click to move the playhead here`}
          >
            {w.text}{" "}
          </span>
        );
      })}
      {words.length === 0 && <p className="text-muted-foreground">No transcript for this range.</p>}
    </div>
  );
}
