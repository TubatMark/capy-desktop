"use client";
import { useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyText } from "@/components/copy-text";
import { PLATFORM_NAME } from "@/components/accounts-panel";
import { AiReview } from "@/components/ai-review";
import { api } from "@/hooks/use-job";
import { fmtSlot } from "@/hooks/use-queue";
import type { ResultsState } from "@/hooks/use-post-results";
import { zonedToUtc } from "@/lib/post-time";
import { queueLink } from "@/lib/queue-source";
import {
  entryTime,
  metricValue,
  missingReason,
  postKind,
  postThumb,
  publicationsFor,
} from "@/lib/queue-calendar";
import type { MetricKey, PerformancePublication } from "@/lib/performance";
import type { QueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  DELIVERY_WORDS,
  MetricsRow,
  PlatformStatus,
  PostThumb,
  noResultsReason,
} from "./post-bits";
import { sourceLine } from "./day-posts";

const THUMB_WORDS: Record<string, string> = {
  "not-requested": "not sent",
  pending: "sending",
  accepted: "sent (YouTube may not show it on Shorts)",
  refused: "not accepted",
  unknown: "not confirmed",
};
const VIS_WORDS: Record<string, string> = {
  unknown: "unknown",
  private: "private",
  unlisted: "unlisted",
  inbox: "in the app's inbox",
  scheduled: "scheduled",
  public: "public",
};

/** The full story of one clip's post: picture, text, review, delivery, results and what you can do next. */
export function PostDetail({
  entries,
  tz,
  tzLabel,
  channels,
  publications,
  resultsState,
  resultsBusy,
  resultsError,
  onRefreshResults,
  schedulingVerified,
  onChange,
  onClose,
}: {
  entries: QueueEntry[];
  tz: string;
  tzLabel: string;
  channels: Map<string, string>;
  publications: PerformancePublication[];
  resultsState: ResultsState;
  resultsBusy: boolean;
  resultsError: string | null;
  onRefreshResults: () => void;
  schedulingVerified: boolean;
  onChange: (msg?: string) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const first = entries[0]!;
  const kind = postKind(entries);
  const at = Math.min(...entries.map(entryTime));
  const pubs = publicationsFor(entries, publications);
  const posted = entries.find((e) => e.result?.url);
  const watch = posted
    ? { url: posted.result!.url!, on: PLATFORM_NAME[posted.platform] }
    : pubs[0]?.remoteId
      ? {
          url: `https://www.youtube.com/watch?v=${encodeURIComponent(pubs[0].remoteId)}`,
          on: "YouTube",
        }
      : undefined;
  const source = sourceLine(first, channels);
  const aiReview = entries.find((e) => e.aiReview)?.aiReview;
  const history = entries
    .flatMap((e) => e.history.map((h) => ({ ...h, p: e.platform })))
    .sort((a, b) => b.t - a.t);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-fade fixed inset-0 z-40 bg-[var(--ink)]/25" />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (confirming) {
              e.preventDefault();
              setConfirming(false);
            }
          }}
          className="sheet-in fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background shadow-[-12px_0_40px_-16px_oklch(0.24_0.03_45/30%)] outline-none"
        >
          <header className="flex items-start gap-3 border-b bg-background/95 px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground tabular-nums">
                {fmtSlot(at, tz)}
              </p>
              <Dialog.Title className="text-lg font-semibold leading-snug text-balance">
                {first.clipTitle}
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </header>

          <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
            <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
              {first.videoUrl ? (
                <video
                  src={first.videoUrl}
                  poster={postThumb(entries)}
                  controls
                  preload="none"
                  className="aspect-[9/16] w-full rounded-lg bg-black object-contain shadow-[0_4px_16px_-6px_oklch(0.24_0.03_45/35%)]"
                />
              ) : (
                <PostThumb src={postThumb(entries)} className="w-full" />
              )}
              <div className="min-w-0 space-y-3 text-sm">
                <div className="flex flex-wrap gap-1.5">
                  {entries.map((e) => (
                    <PlatformStatus key={e.key} e={e} />
                  ))}
                </div>
                {source && (
                  <div>
                    <p className="text-xs text-muted-foreground">Made from</p>
                    <p className="text-pretty">{source}</p>
                  </div>
                )}
                {first.madeForKids && (
                  <span className="inline-block rounded-md bg-sky-500/15 px-1.5 py-0.5 text-xs font-medium text-sky-800">
                    Made for kids
                  </span>
                )}
                <div className="flex flex-col items-start gap-1.5">
                  {watch && (
                    <a
                      href={watch.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                    >
                      Watch on {watch.on}
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                  <Link
                    href={queueLink(first)}
                    className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  >
                    Open the clip in capy
                  </Link>
                </div>
              </div>
            </div>

            <Actions
              entries={entries}
              at={at}
              tz={tz}
              tzLabel={tzLabel}
              confirming={confirming}
              setConfirming={setConfirming}
              schedulingVerified={schedulingVerified}
              onChange={onChange}
            />

            <Section
              title="How it's doing"
              aside={
                resultsState === "ready" && pubs.some((p) => p.remoteId) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resultsBusy}
                    onClick={onRefreshResults}
                  >
                    {resultsBusy ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    Refresh numbers
                  </Button>
                ) : undefined
              }
            >
              {pubs.length ? (
                pubs.map((p) => <Results key={p.key} publication={p} />)
              ) : (
                <p className="text-sm text-muted-foreground">
                  {noResultsReason(resultsState, kind, entries)}
                  {resultsState === "disconnected" && (
                    <>
                      {" "}
                      <Link
                        href="/settings#accounts"
                        className="underline underline-offset-2"
                      >
                        Open Settings
                      </Link>
                    </>
                  )}
                </p>
              )}
              {resultsError && (
                <p role="alert" className="text-sm text-red-700">
                  {resultsError}
                </p>
              )}
            </Section>

            <Section title="What it posts with">
              <div className="space-y-4">
                {entries.map((e) => (
                  <PostText key={e.key} e={e} />
                ))}
              </div>
            </Section>

            {aiReview && (
              <Section title="AI review">
                <AiReview review={aiReview} />
              </Section>
            )}

            {entries.some((e) => e.delivery) && (
              <Section title="Delivery">
                <div className="space-y-3">
                  {entries.map((e) =>
                    e.delivery ? (
                      <Delivery
                        key={e.key}
                        e={e}
                        tz={tz}
                        onChange={onChange}
                      />
                    ) : null,
                  )}
                </div>
              </Section>
            )}

            <Section title="History">
              {history.length ? (
                <ol className="space-y-1.5 text-xs">
                  {history.map((h, i) => (
                    <li key={i} className="grid grid-cols-[auto_1fr] gap-x-3">
                      <span className="tabular-nums text-muted-foreground">
                        {fmtSlot(h.t, tz)}
                      </span>
                      <span className="text-pretty">
                        <b className="font-medium">{PLATFORM_NAME[h.p]}:</b>{" "}
                        {h.msg}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nothing has happened yet.
                </p>
              )}
            </Section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const EXTRA: { key: MetricKey; label: string }[] = [
  { key: "engagedViews", label: "Engaged views" },
  { key: "averageViewDuration", label: "Avg. watch time" },
  { key: "estimatedMinutesWatched", label: "Total minutes watched" },
];

function Results({ publication }: { publication: PerformancePublication }) {
  const measured = Object.values(publication.metrics)
    .map((m) => (m.availability === "available" ? m.measuredAt : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  return (
    <div className="space-y-2">
      <MetricsRow publication={publication} size="lg" />
      <dl className="grid grid-cols-3 gap-2 text-xs">
        {EXTRA.map(({ key, label }) => {
          const v = metricValue(publication.metrics[key]);
          return (
            <div key={key}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular-nums">
                {v
                  ? `${Math.round(v.value).toLocaleString("en-US")}${v.unit === "seconds" ? "s" : ""}`
                  : missingReason(publication.metrics[key])}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="text-[11px] text-muted-foreground">
        {measured
          ? `Numbers from YouTube, last checked ${new Date(measured).toLocaleString()}.`
          : "Not checked with YouTube yet."}{" "}
        Missing numbers are unknown, not zero.
      </p>
    </div>
  );
}

function PostText({ e }: { e: QueueEntry }) {
  const t = e.text;
  return (
    <div className="space-y-1.5 rounded-lg border bg-card p-3 text-sm">
      <p className="text-xs font-medium text-muted-foreground">
        {PLATFORM_NAME[e.platform]}
      </p>
      {t.title && <p className="font-medium text-pretty">{t.title}</p>}
      {t.description && (
        <p className="whitespace-pre-wrap text-pretty text-muted-foreground">
          {t.description}
        </p>
      )}
      {t.caption && (
        <p className="whitespace-pre-wrap text-pretty">{t.caption}</p>
      )}
      {!!t.tags?.length && (
        <ul className="flex flex-wrap gap-1 pt-0.5" aria-label="Tags">
          {t.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-md bg-secondary px-1.5 py-0.5 text-xs"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
      {!t.title && !t.description && !t.caption && (
        <p className="text-muted-foreground">No text set.</p>
      )}
    </div>
  );
}

function Delivery({
  e,
  tz,
  onChange,
}: {
  e: QueueEntry;
  tz: string;
  onChange: (msg?: string) => void;
}) {
  const d = e.delivery!;
  return (
    <div className="space-y-1 rounded-lg border bg-card p-3 text-xs">
      <p className="text-sm font-medium">
        {PLATFORM_NAME[e.platform]}: {DELIVERY_WORDS[d.state]}
      </p>
      <p>Who can see it: {VIS_WORDS[d.visibility] ?? d.visibility}</p>
      <p>Thumbnail: {THUMB_WORDS[d.thumbnail.status] ?? d.thumbnail.status}</p>
      {d.observedAt && (
        <p>Last checked {new Date(d.observedAt).toLocaleString()}</p>
      )}
      {d.nextTryAt && <p>Next check {fmtSlot(d.nextTryAt, tz)}</p>}
      {d.reason && <p className="text-muted-foreground">{d.reason}</p>}
      {d.visibility === "scheduled" && (
        <p>
          YouTube has accepted this schedule. Pausing capy does not cancel it.
          Manage changes in YouTube Studio.
        </p>
      )}
      {d.state !== "public" && (
        <Button
          size="sm"
          variant="outline"
          className="mt-1"
          onClick={async () => {
            try {
              await api(`/api/queue/${encodeURIComponent(e.key)}/check-status`, {
                method: "POST",
              });
              onChange();
            } catch (error) {
              onChange(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Check status again
        </Button>
      )}
    </div>
  );
}

/** Post now / change time / remove, retries and the YouTube remote schedule. Post now always asks first. */
function Actions({
  entries,
  at,
  tz,
  tzLabel,
  confirming,
  setConfirming,
  schedulingVerified,
  onChange,
}: {
  entries: QueueEntry[];
  at: number;
  tz: string;
  tzLabel: string;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  schedulingVerified: boolean;
  onChange: (msg?: string) => void;
}) {
  const [moving, setMoving] = useState(false);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (
    e: QueueEntry,
    action: "post-now" | "retry" | "reject" | "check-status",
  ) => {
    try {
      await api(`/api/queue/${encodeURIComponent(e.key)}/${action}`, {
        method: "POST",
      });
      onChange();
    } catch (error) {
      onChange(error instanceof Error ? error.message : String(error));
    }
  };
  const pending = entries.filter(
    (e) =>
      !e.delivery &&
      !e.remoteSchedule &&
      (e.status === "scheduled" || e.status === "failed"),
  );
  const problems = entries.filter(
    (e) => e.status === "needs_action" || e.status === "failed",
  );
  const remote = entries.filter(
    (e) => !e.delivery && e.platform === "youtube" && e.status === "scheduled",
  );
  if (!pending.length && !problems.length && !remote.length) return null;
  const pendingSlot = Math.min(...pending.map((e) => e.slotAt ?? at));
  const names = pending.map((e) => PLATFORM_NAME[e.platform]).join(" and ");

  return (
    <section className="space-y-3" aria-label="What you can do">
      <h3 className="text-sm font-semibold">What you can do</h3>

      {problems.map((e) => (
        <div
          key={e.key}
          className={cn(
            "space-y-2 rounded-lg p-3 text-sm",
            e.status === "failed"
              ? "bg-destructive/10 text-red-900"
              : "bg-amber-500/10 text-amber-950",
          )}
        >
          <p className="text-pretty">
            <b>{PLATFORM_NAME[e.platform]}:</b>{" "}
            {e.result?.note ?? e.error ?? "Something needs a look."}
            {e.nextTryAt ? ` Trying again ${fmtSlot(e.nextTryAt, tz)}.` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {e.result?.url && (
              <a
                href={e.result.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                Open <ExternalLink className="size-3" />
              </a>
            )}
            {e.platform === "tiktok" &&
              e.status === "needs_action" &&
              e.text.caption && <CopyText text={e.text.caption} />}
            {e.authBlocked && (
              <Link
                href="/settings#accounts"
                className="underline underline-offset-2"
              >
                Reconnect in Settings
              </Link>
            )}
            {(!e.delivery || e.deliveryCanRetry) &&
              !e.remoteSchedule &&
              (e.status === "failed" ||
                (e.status === "needs_action" && !e.result?.id)) &&
              !e.authBlocked && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => act(e, "retry")}
                >
                  <RotateCw /> Retry
                </Button>
              )}
          </div>
        </div>
      ))}

      {pending.length > 0 && (
        <div className="space-y-3 rounded-lg border bg-card p-3">
          <p className="text-sm">
            Goes out {fmtSlot(pendingSlot, tz)} on {names}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-expanded={moving}
              onClick={() => setMoving(!moving)}
            >
              <Clock /> Change time
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                for (const e of pending)
                  await api(`/api/queue/${encodeURIComponent(e.key)}`, {
                    method: "DELETE",
                  }).catch(() => {});
                setBusy(false);
                onChange("Removed from the queue");
              }}
            >
              <Trash2 /> Remove from queue
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={confirming}
              onClick={() => setConfirming(true)}
            >
              <Send /> Post now…
            </Button>
          </div>

          {confirming && (
            <div
              role="alertdialog"
              aria-labelledby="post-now-q"
              aria-describedby="post-now-d"
              className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3"
            >
              <p id="post-now-q" className="text-sm font-semibold">
                Post now instead of {fmtSlot(pendingSlot, tz)} ({tzLabel})?
              </p>
              <p id="post-now-d" className="text-xs text-pretty">
                It goes out on {names} right away and the scheduled time is
                dropped. This can&apos;t be undone from capy.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  autoFocus
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await Promise.all(pending.map((e) => act(e, "post-now")));
                    setBusy(false);
                    setConfirming(false);
                  }}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Send />} Yes,
                  post now
                </Button>
              </div>
            </div>
          )}

          {moving && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="datetime-local"
                aria-label="New time"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="w-auto"
              />
              <span className="text-xs text-muted-foreground">
                {tzLabel} time
              </span>
              <Button
                size="sm"
                disabled={!when}
                onClick={async () => {
                  const [d, t] = when.split("T");
                  const [y, m, day] = d!.split("-").map(Number);
                  const [h, min] = t!.split(":").map(Number);
                  const slotAt = zonedToUtc(y!, m!, day!, h!, min!, tz).getTime();
                  for (const e of pending)
                    await api(`/api/queue/${encodeURIComponent(e.key)}`, {
                      method: "PATCH",
                      body: JSON.stringify({ slotAt }),
                    }).catch(() => {});
                  setMoving(false);
                  onChange(`Moved to ${fmtSlot(slotAt, tz)}`);
                }}
              >
                Move
              </Button>
            </div>
          )}
        </div>
      )}

      {remote.map((e) => (
        <RemoteScheduleForm
          key={e.key}
          entry={e}
          verified={schedulingVerified}
          onChange={onChange}
        />
      ))}
    </section>
  );
}

function RemoteScheduleForm({
  entry,
  verified,
  onChange,
}: {
  entry: QueueEntry;
  verified: boolean;
  onChange: (msg?: string) => void;
}) {
  const [when, setWhen] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <details className="rounded-lg border bg-card px-3 py-2 text-xs">
      <summary className="cursor-pointer text-sm">
        YouTube upload ahead and remote schedule
      </summary>
      <div className="space-y-2 py-2">
        <p>
          {verified
            ? "Choose an exact publication time and approve a new package."
            : "Unavailable until remote scheduling is verified for this exact publishing destination through a separately authorized upload."}
        </p>
        {entry.remoteSchedule && (
          <p>
            Approved for{" "}
            {new Date(entry.remoteSchedule.publishAt).toLocaleString()},
            uploading up to {entry.remoteSchedule.uploadAheadMinutes} minutes
            ahead.
          </p>
        )}
        <label className="block">
          Publish at (this computer’s time zone)
          <Input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            disabled={!verified}
          />
        </label>
        <label className="block">
          Upload ahead (minutes, 1–1440)
          <Input
            type="number"
            min={1}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            disabled={!verified}
          />
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            disabled={!verified}
          />
          I approve uploading early and publication by YouTube at this time.
          Pausing or closing capy cannot cancel an accepted remote schedule.
        </label>
        <Button
          size="sm"
          disabled={!verified || !ack || !when || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(
                `/api/queue/${encodeURIComponent(entry.key)}/schedule`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    publishAt: new Date(when).getTime(),
                    uploadAheadMinutes: minutes,
                    acknowledgeRemoteSchedule: ack,
                  }),
                },
              );
              onChange("Remote schedule explicitly approved");
            } catch (error) {
              onChange(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          Approve new remote schedule
        </Button>
      </div>
    </details>
  );
}
