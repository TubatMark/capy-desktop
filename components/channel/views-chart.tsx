"use client";
import { useMemo, useState } from "react";
import { num, shortDate } from "@/components/channel/format";

/** Daily views for the last 28 days: an area chart with its scale, its dates, and the day under the pointer. */
export function ViewsChart({ days }: { days: { day: string; views: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 168;
  const pad = { t: 10, b: 6 };
  const max = Math.max(1, ...days.map((d) => d.views));
  const pts = useMemo(
    () =>
      days.map((d, i) => ({
        x: days.length < 2 ? W / 2 : (i / (days.length - 1)) * W,
        y: pad.t + (1 - d.views / max) * (H - pad.t - pad.b),
      })),
    [days, max],
  );
  if (!days.length) return <p className="py-10 text-center text-sm text-muted-foreground">No views in the last 28 days yet.</p>;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts.at(-1)!.x} ${H} L${pts[0]!.x} ${H} Z`;
  const total = days.reduce((n, d) => n + d.views, 0);
  const h = hover === null ? null : { d: days[hover]!, p: pts[hover]! };

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-sm">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{num(total)}</span> <span className="text-muted-foreground">views in 28 days</span>
        </p>
        <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {h ? `${shortDate(h.d.day + "T12:00:00Z")}: ${h.d.views.toLocaleString("en-US")} views` : `Peak ${max.toLocaleString("en-US")} a day`}
        </p>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-40 w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)} role="img" aria-label={`Daily views, ${total} in total`}>
          <defs>
            <linearGradient id="views-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--primary)" stopOpacity="0.32" />
              <stop offset="1" stopColor="var(--primary)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} x2={W} y1={pad.t + f * (H - pad.t - pad.b)} y2={pad.t + f * (H - pad.t - pad.b)} stroke="var(--grid-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} fill="url(#views-fill)" />
          <path d={line} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {h && <line x1={h.p.x} x2={h.p.x} y1={0} y2={H} stroke="var(--ink)" strokeOpacity={0.25} strokeWidth={1} vectorEffect="non-scaling-stroke" />}
          {days.map((_, i) => (
            <rect key={i} x={pts[i]!.x - W / days.length / 2} y={0} width={W / days.length} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
        {h && (
          <span
            className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--primary)] bg-card"
            style={{ left: `${(h.p.x / W) * 100}%`, top: `${(h.p.y / H) * 100}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>{shortDate(days[0]!.day + "T12:00:00Z")}</span>
        <span>{shortDate(days.at(-1)!.day + "T12:00:00Z")}</span>
      </div>
    </div>
  );
}
