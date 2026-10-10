"use client";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ImageOff,
  Loader2,
  XCircle,
} from "lucide-react";
import { PLATFORM_NAME } from "@/components/accounts-panel";
import {
  metricValue,
  missingReason,
  type PostKind,
} from "@/lib/queue-calendar";
import type { DeliveryState } from "@/lib/delivery";
import type { MetricKey, PerformancePublication } from "@/lib/performance";
import type { QueueEntry } from "@/lib/types";
import type { ResultsState } from "@/hooks/use-post-results";
import { cn } from "@/lib/utils";

/** The three calendar buckets: one icon, one mark shape and one plain label each, so color is never the only cue. */
export const KIND: Record<
  PostKind,
  { label: string; icon: typeof Clock; mark: string; text: string }
> = {
  posted: {
    label: "Posted",
    icon: CheckCircle2,
    mark: "rounded-full bg-[var(--gauge-good)]",
    text: "text-emerald-800",
  },
  scheduled: {
    label: "Scheduled",
    icon: Clock,
    mark: "rounded-full border-[1.5px] border-[var(--ink)]/70 bg-card",
    text: "text-foreground",
  },
  attention: {
    label: "Needs a look",
    icon: AlertTriangle,
    mark: "rotate-45 rounded-[1px] bg-[var(--gauge-poor)]",
    text: "text-red-800",
  },
};

export function KindMark({
  kind,
  className,
}: {
  kind: PostKind;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0", KIND[kind].mark, className)}
    />
  );
}

/** What the platform says about a delivery, in plain words. */
export const DELIVERY_WORDS: Record<DeliveryState, string> = {
  queued: "Waiting to upload",
  uploading: "Uploading",
  uploaded: "Uploaded",
  processing: "YouTube is processing it",
  scheduled: "Scheduled on YouTube",
  public: "Live",
  "needs-action": "Needs your attention",
  failed: "Didn't go through",
  "delivery-unknown": "Not sure it went through",
};

/** One platform's status for this clip: "YouTube · Live", "TikTok · Scheduled"… */
export function PlatformStatus({ e }: { e: QueueEntry }) {
  const name = PLATFORM_NAME[e.platform];
  const base =
    "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium";
  if (e.delivery) {
    const live = e.delivery.state === "public";
    const bad =
      e.delivery.state === "failed" || e.delivery.state === "needs-action";
    const Icon = live ? CheckCircle2 : bad ? AlertTriangle : Clock;
    return (
      <span
        className={cn(
          base,
          live
            ? "bg-emerald-500/15 text-emerald-800"
            : bad
              ? "bg-amber-500/15 text-amber-900"
              : "bg-secondary text-secondary-foreground",
        )}
      >
        <Icon className="size-3" /> {name} · {DELIVERY_WORDS[e.delivery.state]}
      </span>
    );
  }
  if (e.status === "posted")
    return e.result?.url ? (
      <a
        href={e.result.url}
        target="_blank"
        rel="noreferrer"
        className={cn(
          base,
          "relative z-10 bg-emerald-500/15 text-emerald-800 hover:underline",
        )}
      >
        <CheckCircle2 className="size-3" /> {name} · Posted
      </a>
    ) : (
      <span className={cn(base, "bg-emerald-500/15 text-emerald-800")}>
        <CheckCircle2 className="size-3" /> {name} · Posted
      </span>
    );
  if (e.status === "posting")
    return (
      <span className={cn(base, "bg-secondary text-secondary-foreground")}>
        <Loader2 className="size-3 animate-spin" /> {name} · Posting
      </span>
    );
  if (e.status === "needs_action")
    return (
      <span className={cn(base, "bg-amber-500/15 text-amber-900")}>
        <AlertTriangle className="size-3" /> {name} · Needs you
      </span>
    );
  if (e.status === "failed")
    return (
      <span className={cn(base, "bg-destructive/15 text-red-800")}>
        <XCircle className="size-3" /> {name} · Didn&apos;t post
      </span>
    );
  return (
    <span className={cn(base, "bg-secondary text-secondary-foreground")}>
      <Clock className="size-3" /> {name} · Scheduled
    </span>
  );
}

/** A 9:16 picture slot. Shows the clip's frame; a designed thumbnail can be passed in the same way later. */
export function PostThumb({
  src,
  alt = "",
  className,
}: {
  src?: string;
  alt?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative aspect-[9/16] shrink-0 overflow-hidden rounded-lg bg-muted shadow-[0_1px_2px_oklch(0.24_0.03_45/12%),0_4px_12px_-4px_oklch(0.24_0.03_45/18%)]",
        className,
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="size-full object-cover"
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
          <ImageOff className="size-5" />
          <span className="text-[10px]">No picture yet</span>
        </div>
      )}
    </div>
  );
}

const SHOWN: { key: MetricKey; label: string }[] = [
  { key: "views", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "averageViewPercentage", label: "Avg. watched" },
];

const fmtNum = (v: number, unit: string) =>
  unit === "percent"
    ? `${Math.round(v)}%`
    : unit === "seconds"
      ? `${Math.round(v)}s`
      : v >= 10_000
        ? new Intl.NumberFormat("en-US", {
            notation: "compact",
            maximumFractionDigits: 1,
          }).format(v)
        : v.toLocaleString("en-US");

/** Why there are no numbers for this post at all. */
export function noResultsReason(
  state: ResultsState,
  kind: PostKind,
  entries: QueueEntry[],
) {
  if (state === "loading") return "Loading numbers…";
  if (state === "disconnected")
    return "Connect YouTube in Settings to see views and likes.";
  if (state === "error") return "Couldn't load numbers right now.";
  if (!entries.some((e) => e.platform === "youtube"))
    return "Numbers are shown for YouTube posts only for now.";
  if (kind !== "posted") return "Numbers show up once it's live.";
  return "Numbers show up after YouTube confirms the post.";
}

/** Views, likes, comments and average % watched for one published video. Missing values say why, never 0. */
export function MetricsRow({
  publication,
  size = "sm",
}: {
  publication: PerformancePublication;
  size?: "sm" | "lg";
}) {
  const vals = SHOWN.map((s) => ({
    ...s,
    m: publication.metrics[s.key],
    v: metricValue(publication.metrics[s.key]),
  }));
  const missing = vals.filter((x) => !x.v);
  const stale = vals.some((x) => x.v?.stale);
  return (
    <div className="space-y-1.5">
      <dl
        className={cn(
          "grid grid-cols-4 divide-x divide-border rounded-lg bg-muted/50",
          size === "lg" ? "py-3" : "py-2",
        )}
      >
        {vals.map(({ key, label, v, m }) => (
          <div key={key} className="min-w-0 px-2.5 first:pl-3">
            <dt className="truncate text-[11px] text-muted-foreground">
              {label}
            </dt>
            <dd
              className={cn(
                "font-semibold tabular-nums tracking-tight",
                size === "lg" ? "text-xl" : "text-sm",
                !v && "text-muted-foreground",
              )}
              title={v ? undefined : missingReason(m)}
            >
              {v ? fmtNum(v.value, v.unit) : "—"}
              {v?.stale && (
                <span className="ml-0.5 align-super text-[9px] font-normal text-muted-foreground">
                  *
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {(missing.length > 0 || stale) && (
        <p className="text-[11px] text-muted-foreground">
          {missing.length === SHOWN.length
            ? missingReason(missing[0]!.m)
            : missing.length
              ? `${missing.map((x) => x.label).join(", ")}: ${missingReason(missing[0]!.m)}`
              : ""}
          {stale && `${missing.length ? " · " : ""}* last known number`}
        </p>
      )}
    </div>
  );
}
