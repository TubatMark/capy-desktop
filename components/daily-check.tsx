"use client";
import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/hooks/use-job";
import type { DailyReport, Health, Tuning } from "@/lib/daily-check";
import { cn } from "@/lib/utils";

const TONE: Record<Health, { label: string; className: string }> = {
  "too-early": { label: "Too early", className: "bg-slate-500/15 text-slate-800" },
  working: { label: "Working", className: "bg-emerald-600/15 text-emerald-900" },
  weak: { label: "Weak", className: "bg-amber-500/20 text-amber-900" },
  "not-reaching": { label: "Not reaching viewers", className: "bg-red-600/15 text-red-900" },
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-lg font-semibold tabular-nums">{value}</p>
    <p className="text-xs text-muted-foreground">{label}</p>
  </div>
);

/** What the daily check found on posted Shorts, what capy changed, and what only the owner can do. */
export function DailyCheck({ onChecked }: { onChecked?: () => void }) {
  const [data, setData] = useState<{ report: DailyReport | null; tuning: Tuning } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<{ report: DailyReport | null; tuning: Tuning }>("/api/daily-check").then(setData).catch((e) => setErr(String(e.message ?? e))), []);
  useEffect(() => {
    void load();
  }, [load]);
  async function check() {
    setBusy(true);
    setErr(null);
    try {
      setData(await api("/api/daily-check", { method: "POST" }));
      onChecked?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const r = data?.report;
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4" aria-label="Daily check">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-medium">
          <Activity className="size-4" /> Daily check
          {r && <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", TONE[r.health].className)}>{TONE[r.health].label}</span>}
        </h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {r && <span>Checked {new Date(r.at).toLocaleString()}</span>}
          <Button size="sm" variant="outline" disabled={busy} onClick={check}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Check now
          </Button>
        </div>
      </div>
      {!r && !busy && <p className="text-sm text-muted-foreground">capy checks posted Shorts once a day. The first check runs shortly.</p>}
      {r && (
        <>
          <p className="text-sm">{r.summary}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Shorts judged" value={String(r.judged)} />
            <Stat label="Reached the feed" value={String(r.reachedFeed)} />
            <Stat label="Median views" value={r.medianViews.toLocaleString("en-US")} />
            <Stat label="Stayed to watch" value={r.stayedToWatch === undefined ? "—" : `${Math.round(r.stayedToWatch * 100)}%`} />
          </div>
          {r.actions.map((a) => (
            <p key={a} className="flex items-start gap-1.5 text-sm">
              <Wrench className="mt-0.5 size-4 shrink-0 text-primary" /> {a}
            </p>
          ))}
          {r.needsYou.map((a) => (
            <p key={a} className="flex items-start gap-1.5 text-sm text-orange-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {a}
            </p>
          ))}
          {!r.actions.length && !r.needsYou.length && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5" /> Nothing changed today.
            </p>
          )}
          {data && (
            <p className="text-xs text-muted-foreground">
              Now: {data.tuning.narrate === "all" ? "narrating every new Short" : data.tuning.narrate === "off" ? "not narrating" : "narrating half of new Shorts"}, clips up to {data.tuning.clipMaxSec} seconds.
              {r.bestCreators.some((c) => c.feedViews > 0) ? ` Best in the feed: ${r.bestCreators.filter((c) => c.feedViews > 0).map((c) => c.creator).join(", ")}.` : ""}
            </p>
          )}
        </>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
    </section>
  );
}
