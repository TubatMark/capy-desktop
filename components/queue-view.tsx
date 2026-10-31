"use client";
import { queueGroup, queueCollection, queueLink } from "@/lib/queue-source";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Loader2, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReviewCard } from "@/components/review-card";
import { QueueCalendar } from "@/components/queue/queue-calendar";
import { DailyCheck } from "@/components/daily-check";
import { DayPosts } from "@/components/queue/day-posts";
import { ShortKanban } from "@/components/queue/short-kanban";
import { ViewToggle, useBoardView } from "@/components/view-toggle";
import { GAP_MS, POSTS_PER_DAY } from "@/lib/post-time";
import { PostDetail } from "@/components/queue/post-detail";
import { api } from "@/hooks/use-job";
import { useQueue } from "@/hooks/use-queue";
import { usePostResults, useSourceChannels } from "@/hooks/use-post-results";
import { bucketByDay, dayKey, nearestDay } from "@/lib/queue-calendar";
import { nearDuplicateClusters } from "@/lib/similarity";
import type { QueueEntry } from "@/lib/types";

const group = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

/** "America/New_York" -> "New York" */
const zoneCity = (tz: string) =>
  (tz.split("/").pop() ?? tz).replace(/_/g, " ");

/** Every Short on its way out or already posted, as a board or as a calendar. */
export function QueueView() {
  const [mode, setMode] = useBoardView("short-form");
  const [reviewing, setReviewing] = useState<string | null>(null);
  const { data, refresh } = useQueue();
  const results = usePostResults();
  const channels = useSourceChannels();
  const [toast, setToast] = useState<string | null>(null);
  const tz = data?.audienceTz ?? "America/New_York";
  const tzLabel = zoneCity(tz);

  const [today, setToday] = useState(() => dayKey(Date.now(), tz));
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // the audience zone arrives with the data; "today" (and the default selection) follow it
  useEffect(() => {
    const tick = () => setToday(dayKey(Date.now(), tz));
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [tz]);
  const day = selected ?? today;
  const month = view ?? day;

  const review = useMemo(
    () =>
      group(data?.entries.filter((e) => e.status === "review") ?? [], (e) =>
        queueGroup(e),
      ),
    [data],
  );
  const clips = useMemo(
    () => group(data?.entries ?? [], (e) => queueGroup(e)),
    [data],
  );
  // waiting clips the AIs called near-duplicates of each other
  const dupes = useMemo(
    () =>
      nearDuplicateClusters(
        [...review.entries()].map(([id, es]) => ({
          id,
          similarity: es.find((e) => e.similarity)?.similarity,
        })),
      ),
    [review],
  );
  const byVideo = useMemo(
    () =>
      group(
        [...review.values()].map((es) => es[0]!),
        (e) => queueCollection(e),
      ),
    [review],
  );
  const days = useMemo(
    () => bucketByDay(data?.entries ?? [], tz),
    [data, tz],
  );
  const openEntries = useMemo(
    () =>
      open
        ? (data?.entries.filter(
            (e) =>
              queueGroup(e) === open &&
              e.status !== "review" &&
              e.status !== "rejected",
          ) ?? [])
        : [],
    [data, open],
  );

  /** A linked similar clip: scroll to its review card, or open its post. */
  const openClip = (id: string) => {
    const es = clips.get(id) ?? [];
    if (es.some((e) => e.status === "review")) {
      setOpen(null);
      if (mode === "kanban") return setReviewing(id);
      const el = document.getElementById(`review-${id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
      el?.animate?.(
        [{ boxShadow: "0 0 0 3px var(--primary)" }, { boxShadow: "0 0 0 0 transparent" }],
        { duration: 1600, easing: "ease-out" },
      );
      return;
    }
    if (es.some((e) => e.status !== "rejected")) setOpen(id);
    else if (es[0]) window.location.assign(queueLink(es[0]));
  };

  const done = (msg?: string) => {
    if (msg) {
      setToast(msg);
      setTimeout(() => setToast(null), 4000);
    }
    void refresh();
  };

  if (!data)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading your Shorts…
      </p>
    );

  const schedulingVerified = (es: QueueEntry[]) =>
    data.capabilities?.some(
      (c) =>
        c.platform === "youtube" &&
        c.accountId ===
          es.find((e) => e.platform === "youtube")?.publishPackage?.accountId &&
        c.scheduling === "verified",
    ) ?? false;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Smartphone className="size-6 text-primary" /> Short form
          </h1>
          <p className="max-w-prose text-pretty text-sm text-muted-foreground">
            New clips are checked and scheduled on their own, {POSTS_PER_DAY} a
            day, at least {GAP_MS / 3_600_000} hours apart, in {tzLabel} time.{" "}
            <Link
              href="/settings#accounts"
              className="underline underline-offset-2"
            >
              Accounts
            </Link>
          </p>
        </div>
        <ViewToggle view={mode} onChange={setMode} />
      </div>
      {toast && (
        <p
          role="status"
          className="fixed bottom-5 left-1/2 z-[60] max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-primary/40 bg-card px-4 py-2.5 text-sm shadow-[0_8px_24px_-8px_oklch(0.24_0.03_45/35%)]"
        >
          {toast}
        </p>
      )}

      <DailyCheck onChecked={() => void results.refresh()} />

      {mode === "kanban" && (
        <ShortKanban
          entries={data.entries}
          tz={tz}
          onOpen={(id, column) => {
            if (column === "waiting") setReviewing(id);
            else openClip(id);
          }}
        />
      )}

      {mode === "calendar" && <section className="@container space-y-3" aria-label="Posting calendar">
        <div className="space-y-0.5">
          <h2 className="text-lg font-semibold">Scheduled &amp; posted</h2>
          <p className="text-sm text-muted-foreground">
            Pick a day to see what went out or is coming up, and how it&apos;s
            doing.
          </p>
        </div>
        <div className="grid items-start gap-5 @3xl:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
          <div className="@3xl:sticky @3xl:top-4">
            <QueueCalendar
              days={days}
              view={month}
              selected={day}
              today={today}
              tzLabel={tzLabel}
              onView={setView}
              onSelect={setSelected}
            />
          </div>
          <DayPosts
            day={day}
            today={today}
            posts={days.get(day) ?? []}
            tz={tz}
            channels={channels}
            publications={results.data?.publications ?? []}
            resultsState={results.state}
            prevDay={nearestDay(days.keys(), day, -1)}
            nextDay={nearestDay(days.keys(), day, 1)}
            onJump={(d) => {
              setView(d);
              setSelected(d);
            }}
            onOpen={setOpen}
          />
        </div>
      </section>}

      {mode === "calendar" && <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Waiting ({review.size})
        </h2>
        {dupes.map((ids) => {
          const firsts = ids.map((id) => review.get(id)![0]!);
          const rec = ids
            .map((id) => review.get(id)!.find((e) => e.similarity)?.similarity)
            .flatMap((x) => x?.opinions ?? [])
            .find((o) => o.level === "near-duplicate")?.recommendation;
          return (
            <div
              key={ids.join("|")}
              role="note"
              className="space-y-1 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-sm text-orange-950"
            >
              <p className="flex items-center gap-1.5 font-medium">
                <Copy className="size-4 shrink-0" /> {ids.length} clips
                waiting look nearly the same
              </p>
              <p className="text-pretty">
                {firsts.map((f, i) => (
                  <span key={queueGroup(f)}>
                    {i > 0 && (i === firsts.length - 1 ? " and " : ", ")}
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => openClip(queueGroup(f))}
                    >
                      “{f.clipTitle}”
                    </button>
                  </span>
                ))}
                . Posting all of them makes the channel look repetitive.
              </p>
              {rec && (
                <p className="text-pretty">
                  <span className="font-medium">AI recommends:</span> {rec}
                </p>
              )}
            </div>
          );
        })}
        {review.size === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing to review. Render clips and they show up here (with
            Auto-post on and an account connected).
          </p>
        )}
        {[...byVideo.entries()].map(([jobId, firsts]) => (
          <div key={jobId} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm text-muted-foreground">
                {firsts[0]!.videoTitle ?? jobId}
              </p>
              {firsts.length > 1 && !firsts[0]!.source && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const all = data.entries.filter(
                      (e) =>
                        queueCollection(e) === jobId && e.status === "review",
                    );
                    const blocked = new Set(
                      all
                        .filter((e) => e.aiReview?.verdict === "block")
                        .map((e) => e.n),
                    ).size;
                    if (
                      blocked &&
                      !window.confirm(
                        `The AI reviewer blocked ${blocked} of these clips. Approve all of them anyway?`,
                      )
                    )
                      return;
                    try {
                      const r = await api<{ scheduled: QueueEntry[] }>(
                        "/api/queue/approve",
                        {
                          method: "POST",
                          body: JSON.stringify({ jobId, force: blocked > 0 }),
                        },
                      );
                      done(
                        `${new Set(r.scheduled.map((e) => e.n)).size} clips scheduled`,
                      );
                    } catch (e) {
                      done(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  Approve all {firsts.length} from this video
                </Button>
              )}
            </div>
            {firsts.map((f) => (
              <ReviewCard
                key={queueGroup(f)}
                entries={review.get(queueGroup(f))!}
                nextFree={data.nextFree}
                tz={tz}
                onDone={done}
                clips={clips}
                onOpenClip={openClip}
              />
            ))}
          </div>
        ))}
      </section>}

      {reviewing && review.get(reviewing) && (
        <Dialog.Root open onOpenChange={(o) => !o && setReviewing(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
            <Dialog.Content aria-describedby={undefined} className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl">
              <div className="mb-3 flex items-start justify-between gap-3">
                <Dialog.Title className="text-lg font-semibold">Waiting for a slot</Dialog.Title>
                <Dialog.Close aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-muted">
                  <X className="size-4" />
                </Dialog.Close>
              </div>
              <ReviewCard
                entries={review.get(reviewing)!}
                nextFree={data.nextFree}
                tz={tz}
                onDone={(msg) => {
                  setReviewing(null);
                  done(msg);
                }}
                clips={clips}
                onOpenClip={(id) => {
                  setReviewing(null);
                  openClip(id);
                }}
              />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}

      {open && openEntries.length > 0 && (
        <PostDetail
          key={open}
          entries={openEntries}
          tz={tz}
          tzLabel={tzLabel}
          channels={channels}
          publications={results.data?.publications ?? []}
          resultsState={results.state}
          resultsBusy={results.busy}
          resultsError={results.error}
          onRefreshResults={() => void results.refresh()}
          schedulingVerified={schedulingVerified(openEntries)}
          onChange={done}
          onClose={() => setOpen(null)}
          clips={clips}
          onOpenClip={openClip}
        />
      )}
    </div>
  );
}
