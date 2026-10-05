"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, Loader2, RotateCw, Send, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyText } from "@/components/copy-text";
import { PLATFORM_NAME } from "@/components/accounts-panel";
import { ReviewCard } from "@/components/review-card";
import { api } from "@/hooks/use-job";
import { fmtSlot, useQueue } from "@/hooks/use-queue";
import { zonedToUtc } from "@/lib/post-time";
import type { QueueEntry } from "@/lib/types";

const group = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

/** The posting queue: clips waiting for review, then everything scheduled or posted, by day. */
export function QueueView() {
  const { data, refresh } = useQueue();
  const [toast, setToast] = useState<string | null>(null);
  const tz = data?.audienceTz ?? "America/New_York";

  const review = useMemo(() => group(data?.entries.filter((e) => e.status === "review") ?? [], (e) => `${e.jobId}:${e.n}`), [data]);
  const byVideo = useMemo(() => group([...review.values()].map((es) => es[0]!), (e) => e.jobId), [review]);
  const planned = useMemo(() => {
    const live = data?.entries.filter((e) => e.status !== "review" && e.status !== "rejected") ?? [];
    const clips = group(live, (e) => `${e.jobId}:${e.n}`);
    const rows = [...clips.values()].sort((a, b) => (a[0]!.slotAt ?? a[0]!.updatedAt) - (b[0]!.slotAt ?? b[0]!.updatedAt));
    const day = (es: QueueEntry[]) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(es[0]!.slotAt ?? es[0]!.updatedAt));
    return group(rows, day);
  }, [data, tz]);

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
        <Loader2 className="size-4 animate-spin" /> Loading the queue…
      </p>
    );

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Queue</h1>
        <p className="text-sm text-muted-foreground">
          Rendered clips wait here for your OK. Approved clips post at staggered times (at most 2 a day per platform, 4 hours apart) in {tz.replace("_", " ")} time.{" "}
          <Link href="/settings#accounts" className="underline underline-offset-2">
            Accounts
          </Link>
        </p>
      </div>
      {toast && <p className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm">{toast}</p>}

      <section className="space-y-3">
        <h2 className="font-semibold">Waiting for your OK ({review.size})</h2>
        {review.size === 0 && <p className="text-sm text-muted-foreground">Nothing to review. Render clips and they show up here (with Auto-post on and an account connected).</p>}
        {[...byVideo.entries()].map(([jobId, firsts]) => (
          <div key={jobId} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm text-muted-foreground">{firsts[0]!.videoTitle ?? jobId}</p>
              {firsts.length > 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const r = await api<{ scheduled: QueueEntry[] }>("/api/queue/approve", { method: "POST", body: JSON.stringify({ jobId }) });
                    done(`${new Set(r.scheduled.map((e) => e.n)).size} clips scheduled`);
                  }}
                >
                  Approve all {firsts.length} from this video
                </Button>
              )}
            </div>
            {firsts.map((f) => (
              <ReviewCard key={`${f.jobId}:${f.n}`} entries={review.get(`${f.jobId}:${f.n}`)!} nextFree={data.nextFree} tz={tz} onDone={done} />
            ))}
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="font-semibold">Scheduled &amp; posted</h2>
        {planned.size === 0 && <p className="text-sm text-muted-foreground">Nothing scheduled yet.</p>}
        {[...planned.entries()].map(([day, rows]) => (
          <div key={day} className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{day}</h3>
            {rows.map((es) => (
              <ScheduledRow key={`${es[0]!.jobId}:${es[0]!.n}`} entries={es} tz={tz} onChange={done} />
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

function ScheduledRow({ entries, tz, onChange }: { entries: QueueEntry[]; tz: string; onChange: (msg?: string) => void }) {
  const first = entries[0]!;
  const [moving, setMoving] = useState(false);
  const [when, setWhen] = useState("");
  const [open, setOpen] = useState(false);
  const act = async (e: QueueEntry, action: "post-now" | "retry" | "reject") => {
    await api(`/api/queue/${encodeURIComponent(e.key)}/${action}`, { method: "POST" }).catch(() => {});
    onChange();
  };
  const pending = entries.filter((e) => e.status === "scheduled" || e.status === "failed");

  return (
    <div className="space-y-2 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center gap-3">
        {first.thumbUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={first.thumbUrl} alt="" className="h-14 w-8 shrink-0 rounded object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <Link href={`/v/${first.jobId}/clip/${first.n}`} className="block truncate text-sm font-medium hover:underline">
            {first.clipTitle}
          </Link>
          <p className="text-xs text-muted-foreground">{first.slotAt ? fmtSlot(first.slotAt, tz) : "No time set"}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {entries.map((e) => (
            <StatusChip key={e.key} e={e} />
          ))}
        </div>
        {pending.length > 0 && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" title="Post now" onClick={() => Promise.all(pending.map((e) => act(e, "post-now")))}>
              <Send />
            </Button>
            <Button size="sm" variant="ghost" title="Move" onClick={() => setMoving(!moving)}>
              <Clock />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title="Remove from the queue"
              onClick={async () => {
                for (const e of pending) await api(`/api/queue/${encodeURIComponent(e.key)}`, { method: "DELETE" }).catch(() => {});
                onChange();
              }}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      {moving && (
        <div className="flex flex-wrap items-center gap-2">
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-auto" />
          <span className="text-xs text-muted-foreground">{tz.replace("_", " ")} time</span>
          <Button
            size="sm"
            disabled={!when}
            onClick={async () => {
              const [d, t] = when.split("T");
              const [y, m, day] = d!.split("-").map(Number);
              const [h, min] = t!.split(":").map(Number);
              const slotAt = zonedToUtc(y!, m!, day!, h!, min!, tz).getTime();
              for (const e of pending) await api(`/api/queue/${encodeURIComponent(e.key)}`, { method: "PATCH", body: JSON.stringify({ slotAt }) }).catch(() => {});
              setMoving(false);
              onChange(`Moved to ${fmtSlot(slotAt, tz)}`);
            }}
          >
            Move
          </Button>
        </div>
      )}
      {entries.map((e) =>
        e.status === "needs_action" || e.status === "failed" ? (
          <div key={e.key} className="rounded-lg bg-muted/60 p-2 text-xs">
            <p className={e.status === "failed" ? "text-red-700" : "text-amber-800"}>
              <b>{PLATFORM_NAME[e.platform]}:</b> {e.result?.note ?? e.error}
              {e.nextTryAt ? ` · retrying ${fmtSlot(e.nextTryAt, tz)}` : ""}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {e.result?.url && (
                <a href={e.result.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
                  Open <ExternalLink className="size-3" />
                </a>
              )}
              {e.platform === "tiktok" && e.status === "needs_action" && e.text.caption && <CopyText text={e.text.caption} />}
              {e.authBlocked && (
                <Link href="/settings#accounts" className="underline underline-offset-2">
                  Reconnect in Settings
                </Link>
              )}
              {(e.status === "failed" || (e.status === "needs_action" && !e.result?.id)) && !e.authBlocked && (
                <Button size="sm" variant="outline" className="h-7" onClick={() => act(e, "retry")}>
                  <RotateCw /> Retry
                </Button>
              )}
            </div>
          </div>
        ) : null,
      )}
      <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
        {open ? "Hide history" : "History"}
      </button>
      {open && (
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {entries
            .flatMap((e) => e.history.map((h) => ({ ...h, p: e.platform })))
            .sort((a, b) => a.t - b.t)
            .map((h, i) => (
              <li key={i}>
                {new Date(h.t).toLocaleString()} · {PLATFORM_NAME[h.p]} · {h.msg}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function StatusChip({ e }: { e: QueueEntry }) {
  const name = PLATFORM_NAME[e.platform];
  const base = "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs";
  if (e.status === "posted")
    return e.result?.url ? (
      <a href={e.result.url} target="_blank" rel="noreferrer" className={`${base} bg-emerald-500/15 text-emerald-700 hover:underline`}>
        <CheckCircle2 className="size-3" /> {name}
      </a>
    ) : (
      <span className={`${base} bg-emerald-500/15 text-emerald-700`}>
        <CheckCircle2 className="size-3" /> {name}
      </span>
    );
  if (e.status === "posting")
    return (
      <span className={`${base} bg-secondary`}>
        <Loader2 className="size-3 animate-spin" /> {name}
      </span>
    );
  if (e.status === "needs_action")
    return (
      <span className={`${base} bg-amber-500/15 text-amber-800`}>
        <AlertTriangle className="size-3" /> {name}
      </span>
    );
  if (e.status === "failed")
    return (
      <span className={`${base} bg-destructive/15 text-red-700`}>
        <XCircle className="size-3" /> {name}
      </span>
    );
  return (
    <span className={`${base} bg-secondary text-secondary-foreground`}>
      <Clock className="size-3" /> {name}
    </span>
  );
}
