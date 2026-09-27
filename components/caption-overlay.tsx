"use client";
import { useMemo } from "react";
import { groupWords, cleanCaptionWords, STYLES } from "@/src/ass";
import type { Word } from "@/lib/types";
import type { Look } from "@/lib/look";

/** "#rrggbb" → "rgba(r,g,b,a)". */
function rgba(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${a})`;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${a})`;
}

/**
 * Approximates the burned-in captions in the browser so the preview shows what
 * the render will look like: same grouping rules, current word highlighted.
 * Sizes and positions come from `look` in 1080x1920 canvas units and are scaled
 * with container query units, so the phone frame must be a `container-type: inline-size`.
 * `words` are relative to the clip start; `t` is the playhead in clip seconds.
 */
export function CaptionOverlay({ words, t, style, look, hook, showHook }: { words: Word[]; t: number; style: "bold" | "clean"; look: Look; hook?: string; showHook: boolean }) {
  const st = STYLES[style]!;
  // a bigger font fits fewer characters on the 1080px line; scale the style's budget by the size ratio
  const chars = Math.max(6, Math.round((st.groupChars * st.size) / look.size));
  const groups = useMemo(() => groupWords(cleanCaptionWords(words), look.wordsPerLine, st.groupSec, chars), [words, look.wordsPerLine, st.groupSec, chars]);
  const gi = groups.findIndex((g, i) => {
    const next = groups[i + 1]?.[0];
    const end = next ? Math.min(g[g.length - 1]!.end + 0.3, next.start) : g[g.length - 1]!.end + 0.4;
    return t >= g[0]!.start && t < end;
  });
  const g = gi >= 0 ? groups[gi]! : null;
  const bold = style === "bold";
  const highlights = look.highlight !== look.text;
  const fontFamily = bold ? "'Arial Black', Arial, sans-serif" : "Helvetica, Arial, sans-serif";

  return (
    <>
      {showHook && hook && t < 3 && (
        <div className="absolute inset-x-[6%] text-center" style={{ top: `${look.hook.top * 100}%` }}>
          <span
            className="inline-block rounded-[0.2em] px-[0.4em] py-[0.15em] font-black uppercase leading-tight tracking-wide"
            style={{ fontFamily: bold ? fontFamily : undefined, fontSize: `${(look.hook.size / 1080) * 100}cqw`, color: look.hook.text, background: rgba(look.hook.box, 0.7) }}
          >
            {hook}
          </span>
        </div>
      )}
      {g && (
        <div className="absolute inset-x-[6%] text-center" style={{ bottom: `${look.bottom * 100}%` }}>
          <p
            className={"inline-block font-black leading-tight " + (bold ? "uppercase " : "") + (look.box ? "rounded-[0.2em] px-[0.35em] py-[0.12em]" : "")}
            style={{
              fontFamily,
              fontSize: `${(look.size / 1080) * 100}cqw`,
              color: look.text,
              WebkitTextStroke: look.outlineWidth > 0 ? `${(2 * look.outlineWidth) / look.size}em ${look.outline}` : undefined,
              paintOrder: "stroke fill",
              background: look.box ? rgba(look.outline, 0.4) : undefined,
            }}
          >
            {g.map((w, i) => {
              const cur = highlights && t >= w.start && (i === g.length - 1 || t < g[i + 1]!.start);
              return (
                <span key={i} style={cur ? { color: look.highlight } : undefined}>
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
