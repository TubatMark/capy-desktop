"use client";
import { ArrowLeft, ArrowRight, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PLATFORM_NAME } from "@/components/accounts-panel";
import {
  countKinds,
  fmtDay,
  postThumb,
  publicationsFor,
  type DayPost,
} from "@/lib/queue-calendar";
import type { PerformancePublication } from "@/lib/performance";
import type { QueueEntry } from "@/lib/types";
import type { ResultsState } from "@/hooks/use-post-results";
import { cn } from "@/lib/utils";
import {
  KIND,
  MetricsRow,
  PlatformStatus,
  PostThumb,
  noResultsReason,
} from "./post-bits";

export const fmtClock = (at: number, tz: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));

/** "From <video> · <channel>" for a clip. */
export function sourceLine(e: QueueEntry, channels: Map<string, string>) {
  const channel = e.jobId ? channels.get(e.jobId) : undefined;
  return [e.videoTitle, channel].filter(Boolean).join(" · ");
}

/** Everything that went out (or goes out) on one day. */
export function DayPosts({
  day,
  today,
  posts,
  tz,
  channels,
  publications,
  resultsState,
  prevDay,
  nextDay,
  onJump,
  onOpen,
}: {
  day: string;
  today: string;
  posts: DayPost[];
  tz: string;
  channels: Map<string, string>;
  publications: PerformancePublication[];
  resultsState: ResultsState;
  prevDay?: string;
  nextDay?: string;
  onJump: (day: string) => void;
  onOpen: (group: string) => void;
}) {
  const c = countKinds(posts);
  const summary = (["posted", "scheduled", "attention"] as const)
    .filter((k) => c[k])
    .map((k) => `${c[k]} ${KIND[k].label.toLowerCase()}`)
    .join(" · ");

  return (
    <section aria-label={`Posts on ${fmtDay(day)}`} className="min-w-0 space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <h3 className="flex min-w-0 flex-wrap items-center gap-2 text-lg font-semibold text-balance">
          {fmtDay(day)}
          {day === today && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
              Today
            </span>
          )}
        </h3>
        <p className="text-sm text-muted-foreground tabular-nums">
          {summary || "Nothing planned"}
        </p>
      </header>

      {posts.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed bg-card/60 p-5">
          <CalendarDays className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground text-pretty">
            {day < today
              ? "Nothing went out on this day."
              : "Nothing is planned for this day yet. Approved clips get a time automatically."}
          </p>
          {(prevDay || nextDay) && (
            <div className="flex flex-wrap gap-2">
              {prevDay && (
                <Button size="sm" variant="outline" onClick={() => onJump(prevDay)}>
                  <ArrowLeft /> {fmtDay(prevDay, { month: "short", day: "numeric" })}
                </Button>
              )}
              {nextDay && (
                <Button size="sm" variant="outline" onClick={() => onJump(nextDay)}>
                  Next posts: {fmtDay(nextDay, { weekday: "short", month: "short", day: "numeric" })}{" "}
                  <ArrowRight />
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {posts.map((p) => (
            <li key={p.group}>
              <PostCard
                post={p}
                tz={tz}
                channels={channels}
                publications={publications}
                resultsState={resultsState}
                onOpen={() => onOpen(p.group)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PostCard({
  post,
  tz,
  channels,
  publications,
  resultsState,
  onOpen,
}: {
  post: DayPost;
  tz: string;
  channels: Map<string, string>;
  publications: PerformancePublication[];
  resultsState: ResultsState;
  onOpen: () => void;
}) {
  const first = post.entries[0]!;
  const pubs = publicationsFor(post.entries, publications);
  const pub = pubs.find((p) => p.remoteId) ?? pubs[0];
  const source = sourceLine(first, channels);
  const Kind = KIND[post.kind];
  const problem = post.entries.find(
    (e) => e.status === "failed" || e.status === "needs_action",
  );

  return (
    <article
      aria-label={first.clipTitle}
      className={cn(
        "group relative flex gap-3 rounded-xl border bg-card p-3 transition-[border-color,box-shadow] duration-200 focus-within:border-primary hover:border-primary/60 hover:shadow-[0_2px_4px_oklch(0.24_0.03_45/6%),0_10px_24px_-12px_oklch(0.24_0.03_45/22%)] sm:gap-4",
      )}
    >
      <PostThumb
        src={postThumb(post.entries)}
        className="w-20 sm:w-28"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-sm font-semibold tabular-nums">
            {fmtClock(post.at, tz)}
          </span>
          <span className={cn("inline-flex items-center gap-1", Kind.text)}>
            <Kind.icon className="size-3.5" /> {Kind.label}
          </span>
        </div>
        <h4 className="font-medium leading-snug">
          <button
            type="button"
            onClick={onOpen}
            className="line-clamp-2 text-left outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] hover:underline focus-visible:underline"
          >
            {first.clipTitle}
          </button>
        </h4>
        {source && (
          <p className="truncate text-xs text-muted-foreground">
            From {source}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {post.entries.map((e) => (
            <PlatformStatus key={e.key} e={e} />
          ))}
        </div>
        {problem && (
          <p className="text-xs text-amber-900 text-pretty">
            <b>{PLATFORM_NAME[problem.platform]}:</b>{" "}
            {problem.result?.note ?? problem.error ?? "Needs a look."} Open it
            to fix.
          </p>
        )}
        {post.kind === "posted" &&
          (pub ? (
            <MetricsRow publication={pub} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {noResultsReason(resultsState, post.kind, post.entries)}
            </p>
          ))}
      </div>
    </article>
  );
}
