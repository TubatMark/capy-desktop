"use client";
import { useMemo } from "react";
import { groupWords, cleanCaptionWords, STYLES } from "@/src/ass";
import type { Word } from "@/lib/types";

/**
 * Approximates the burned-in captions in the browser so the preview shows what
 * the render will look like: same grouping rules, current word highlighted.
 * `words` are relative to the clip start; `t` is the playhead in clip seconds.
 */
export function CaptionOverlay({ words, t, style, hook, showHook }: { words: Word[]; t: number; style: "bold" | "clean"; hook?: string; showHook: boolean }) {
  const st = STYLES[style]!;
  const groups = useMemo(() => groupWords(cleanCaptionWords(words), st.groupWords, st.groupSec, st.groupChars), [words, st]);
  const gi = groups.findIndex((g, i) => {
    const next = groups[i + 1]?.[0];
    const end = next ? Math.min(g[g.length - 1]!.end + 0.3, next.start) : g[g.length - 1]!.end + 0.4;
    return t >= g[0]!.start && t < end;
  });
  const g = gi >= 0 ? groups[gi]! : null;
  const bold = style === "bold";

  return (
    <>
      {showHook && hook && t < 3 && (
        <div className="absolute inset-x-[6%] top-[15%] text-center">
          <span className="inline-block rounded-md bg-black/75 px-3 py-1.5 text-[clamp(12px,4.4cqw,28px)] font-black uppercase leading-tight tracking-wide text-white" style={{ fontFamily: bold ? "'Arial Black', Arial, sans-serif" : undefined }}>
            {hook}
          </span>
        </div>
      )}
      {g && (
        <div className="absolute inset-x-[6%] bottom-[29%] text-center">
          <p
            className={"text-[clamp(12px,4cqw,26px)] font-black leading-tight " + (bold ? "uppercase" : "")}
            style={{ fontFamily: bold ? "'Arial Black', Arial, sans-serif" : "Helvetica, Arial, sans-serif", WebkitTextStroke: bold ? "0.06em black" : "0.03em rgba(0,0,0,.6)", paintOrder: "stroke fill" }}
          >
            {g.map((w, i) => {
              const cur = bold && t >= w.start && (i === g.length - 1 || t < g[i + 1]!.start);
              return (
                <span key={i} className={cur ? "text-[#ffe500]" : "text-white"}>
                  {w.text}{" "}
                </span>
              );
            })}
          </p>
        </div>
      )}
    </>
  );
}
