"use client";
import Link from "next/link";
import { Check, Clock, Loader2, Play, AlertCircle, Sparkles } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtTime, fmtRemaining } from "@/lib/utils";
import type { ClipState } from "@/lib/types";

/** Phone-shaped card for one pick (the library look). */
export function PickCard({ jobId, clip, onSelect }: { jobId: string; clip: ClipState; onSelect: (v: boolean) => void }) {
  const len = clip.end - clip.start;
  const r = clip.render;
  const seg = clip.segment;

  return (
    <div className="group relative min-w-0">
      <Link
        href={`/v/${jobId}/clip/${clip.n}`}
        className="phone-card relative block min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-lg transition-transform duration-200 hover:-translate-y-1 hover:border-white/30"
      >
        {clip.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={clip.thumbUrl} alt="" className="absolute inset-0 size-full object-cover" />
        ) : (
          <Skeleton className="absolute inset-0 rounded-none" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-black/40" />

        {/* top row */}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <span className="truncate rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-white/90 backdrop-blur">
            {fmtTime(clip.start)} · {Math.round(len)}s
          </span>
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-primary backdrop-blur">
            <Sparkles className="size-3" />
            {clip.score}/10
          </span>
        </div>

        {/* center status */}
        <div className="absolute inset-0 grid place-items-center">
          {r.status === "rendering" ? (
            <div className="rounded-full bg-black/70 p-3 text-white backdrop-blur">
              <Loader2 className="size-6 animate-spin" />
            </div>
          ) : seg?.status === "downloading" || seg?.status === "queued" ? (
            <div className="rounded-full bg-black/70 px-3 py-1.5 text-xs text-white/90 backdrop-blur">
              <Clock className="mr-1 inline size-3" /> fetching
            </div>
          ) : r.status === "done" ? (
            <div className="rounded-full bg-white/90 p-3 text-black opacity-0 transition-opacity group-hover:opacity-100">
              <Play className="size-6 fill-current" />
            </div>
          ) : null}
        </div>

        {/* bottom text */}
        <div className="absolute inset-x-0 bottom-0 min-w-0 p-3">
          {clip.hook && <p className="mb-1 line-clamp-2 break-words text-[11px] font-medium uppercase tracking-wide text-primary">{clip.hook}</p>}
          <p className="line-clamp-2 break-words text-sm font-semibold leading-snug text-white">{clip.title}</p>
          <div className="mt-2 flex min-w-0 items-center gap-2 text-[11px] text-white/70">
            <RenderStatus clip={clip} />
          </div>
        </div>
      </Link>

      {/* 40px hit area around the 20px checkbox: clicks on the padding toggle it too */}
      <div
        className="absolute left-0.5 top-9 z-10 grid size-10 cursor-pointer place-items-center"
        onClick={(e) => {
          e.stopPropagation();
          if (e.target === e.currentTarget) onSelect(!clip.selected);
        }}
      >
        <Checkbox checked={clip.selected} onCheckedChange={(v) => onSelect(v === true)} aria-label="Select clip" />
      </div>
    </div>
  );
}

export function RenderStatus({ clip }: { clip: ClipState }) {
  const r = clip.render;
  if (r.status === "done")
    return (
      <span className="flex items-center gap-1 text-emerald-600">
        <Check className="size-3" /> rendered{r.tookMs ? ` in ${(r.tookMs / 1000).toFixed(0)}s` : ""}
      </span>
    );
  if (r.status === "rendering") return <span className="text-foreground">rendering {Math.round((r.progress ?? 0) * 100)}% · {fmtRemaining(r.remaining ?? 0)}</span>;
  if (r.status === "queued") return <span>queued to render</span>;
  if (r.status === "stale") return <span className="text-amber-700">edited · re-render</span>;
  if (r.status === "error")
    return (
      <span className="flex items-center gap-1 text-red-600">
        <AlertCircle className="size-3" /> failed
      </span>
    );
  if (clip.segment?.status === "error") return <span className="text-red-600">download failed</span>;
  return <span>not rendered</span>;
}
