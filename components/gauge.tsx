"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A half-dial instrument. "score" fills from the left and takes the band's colour (poor / fair / good);
 * "bipolar" fills from the top centre toward the value (a change: below zero is poor, above is good).
 * The arc sweeps to its value once after mount; with reduced motion it simply appears.
 */

type Props = {
  value: number | null | undefined;
  min?: number;
  max?: number;
  label: string;
  /** What the centre shows (default: the rounded value). */
  display?: string;
  /** One line under the label. */
  hint?: string;
  mode?: "score" | "bipolar";
  size?: "md" | "sm";
  className?: string;
};

export function toneOf(score: number): "poor" | "fair" | "good" {
  return score >= 75 ? "good" : score >= 50 ? "fair" : "poor";
}
const STROKE = { poor: "var(--gauge-poor)", fair: "var(--gauge-fair)", good: "var(--gauge-good)" };

export function Gauge({ value, min = 0, max = 100, label, display, hint, mode = "score", size = "md", className }: Props) {
  const known = typeof value === "number" && Number.isFinite(value);
  const pos = known ? Math.min(100, Math.max(0, ((value! - min) / (max - min)) * 100)) : 0;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(pos));
    return () => cancelAnimationFrame(id);
  }, [pos]);

  const sm = size === "sm";
  const W = sm ? 48 : 152;
  const r = sm ? 19 : 62;
  const sw = sm ? 5 : 11;
  const cx = W / 2;
  const cy = r + sw / 2 + (sm ? 1 : 6);
  const H = cy + (sm ? 2 : 6);
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const bip = mode === "bipolar";
  const tone = !known ? null : bip ? (pos >= 50 ? "good" : "poor") : toneOf(pos);
  const color = tone ? STROKE[tone] : "transparent";
  // dash geometry on a pathLength of 100
  const start = bip ? Math.min(50, shown) : 0;
  const len = bip ? Math.abs(shown - 50) : shown;
  const angle = Math.PI * (1 - shown / 100);
  const tip = { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) };
  const text = known ? (display ?? String(Math.round(value!))) : "—";

  return (
    <figure className={cn("flex flex-col items-center", sm ? "w-12" : "w-[152px]", className)} aria-label={`${label}: ${text}`} role="img">
      <div className="relative" style={{ width: W, height: H }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="overflow-visible">
          <path d={arc} fill="none" stroke="var(--gauge-track)" strokeWidth={sw} strokeLinecap="round" />
          {!sm &&
            [0, 25, 50, 75, 100].map((t) => {
              const a = Math.PI * (1 - t / 100);
              const r1 = r + sw / 2 + 3;
              const r2 = r1 + (t % 50 === 0 ? 6 : 4);
              return <line key={t} x1={cx + r1 * Math.cos(a)} y1={cy - r1 * Math.sin(a)} x2={cx + r2 * Math.cos(a)} y2={cy - r2 * Math.sin(a)} stroke="var(--gauge-tick)" strokeWidth={1.25} strokeLinecap="round" />;
            })}
          {known && (
            <path
              d={arc}
              pathLength={100}
              fill="none"
              stroke={color}
              strokeWidth={sw}
              strokeLinecap={len < 1 ? "butt" : "round"}
              strokeDasharray={`${len} 200`}
              strokeDashoffset={-start}
              className="motion-safe:transition-[stroke-dasharray,stroke-dashoffset] motion-safe:duration-[1100ms] motion-safe:ease-[var(--ease-out-expo)]"
            />
          )}
          {known && !sm && (
            <circle
              cx={tip.x}
              cy={tip.y}
              r={sw / 2 + 2.5}
              fill="var(--card)"
              stroke={color}
              strokeWidth={2.5}
              className="motion-safe:transition-[cx,cy] motion-safe:duration-[1100ms] motion-safe:ease-[var(--ease-out-expo)]"
            />
          )}
        </svg>
        <span
          className={cn(
            "absolute inset-x-0 text-center font-semibold tabular-nums tracking-tight",
            sm ? "bottom-0 text-[13px] leading-none" : "bottom-0 text-[28px] leading-none",
            !known && "text-muted-foreground",
          )}
        >
          {text}
        </span>
      </div>
      {!sm && (
        <figcaption className="mt-2 text-center">
          <span className="block text-sm font-medium">{label}</span>
          {hint && <span className="block text-xs text-pretty text-muted-foreground">{hint}</span>}
        </figcaption>
      )}
    </figure>
  );
}
