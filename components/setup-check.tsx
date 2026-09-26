"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CheckResult } from "@/lib/types";

type Status = "idle" | "running" | "done" | "error";

/** Runs GET /api/check (SSE) and lists each result with its fix. */
export function SetupCheck({ lastCheckedAt }: { lastCheckedAt?: number }) {
  const [rows, setRows] = useState<CheckResult[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [problems, setProblems] = useState(0);
  const [checkedAt, setCheckedAt] = useState<number | undefined>(lastCheckedAt);
  const es = useRef<EventSource | null>(null);
  // "x min ago" depends on the clock: render it only on the client to keep hydration clean
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => es.current?.close();
  }, []);

  function start() {
    es.current?.close();
    setRows([]);
    setProblems(0);
    setStatus("running");
    const src = new EventSource("/api/check");
    es.current = src;
    src.addEventListener("check", (ev) => {
      try {
        const r = JSON.parse((ev as MessageEvent).data) as CheckResult;
        setRows((rs) => [...rs.filter((x) => x.name !== r.name), r]);
      } catch {
        /* ignore */
      }
    });
    src.addEventListener("done", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { problems: number; error?: string };
        setProblems(d.problems);
        setStatus(d.error ? "error" : "done");
        if (!d.error) setCheckedAt(Date.now());
      } catch {
        setStatus("done");
      }
      src.close();
    });
    src.onerror = () => {
      // EventSource would reconnect and re-run everything; stop instead
      src.close();
      setStatus((s) => (s === "running" ? "error" : s));
    };
  }

  const running = status === "running";
  const bad = rows.filter((r) => !r.ok).length;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Setup check</CardTitle>
          <CardDescription>
            Confirms yt-dlp, ffmpeg with libass, the video encoder and your Claude login all work.
            {!mounted ? null : checkedAt ? <span className="block">Last run {relTime(checkedAt)}.</span> : <span className="block">Not run yet.</span>}
          </CardDescription>
        </div>
        <Button type="button" onClick={start} disabled={running} variant={rows.length ? "outline" : "default"} className="shrink-0">
          {running ? <Loader2 className="animate-spin" /> : <Play />}
          <span className="hidden sm:inline">{running ? "Checking…" : rows.length ? "Run again" : "Run setup check"}</span>
          <span className="sm:hidden">{running ? "Checking…" : "Run"}</span>
        </Button>
      </CardHeader>
      {(rows.length > 0 || running || status === "error") && (
        <CardContent className="space-y-2">
          <ul className="divide-y rounded-lg border">
            {rows.map((r) => (
              <Row key={r.name} r={r} />
            ))}
            {running && (
              <li className="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 shrink-0 animate-spin" />
                {rows.length >= 6 ? "Asking Claude — this can take up to a minute…" : "Checking…"}
              </li>
            )}
          </ul>
          {status === "done" && (
            <p className={`text-sm font-medium ${problems ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"}`} role="status">
              {problems ? `${problems} problem${problems === 1 ? "" : "s"}. Fix ${problems === 1 ? "it" : "them"}, then run again.` : "All good"}
            </p>
          )}
          {status === "error" && (
            <p className="text-sm font-medium text-red-500" role="alert">
              The check stopped early{bad ? ` (${bad} problem${bad === 1 ? "" : "s"} so far)` : ""}. Run it again.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Row({ r }: { r: CheckResult }) {
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex items-start gap-3">
        {r.ok ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-label="ok" /> : <X className="mt-0.5 size-4 shrink-0 text-red-500" aria-label="failed" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{r.name}</span>
            <span className="break-words text-muted-foreground">{r.detail}</span>
          </div>
          {r.fix && <Fix fix={r.fix} />}
        </div>
      </div>
    </li>
  );
}

function Fix({ fix }: { fix: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(fix);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="mt-1.5 flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2.5 py-1.5 text-xs">
        <code>{fix}</code>
      </pre>
      <Button type="button" size="icon-sm" variant="outline" onClick={copy} aria-label="Copy fix" title="Copy">
        {copied ? <Check className="text-emerald-500" /> : <Copy />}
      </Button>
    </div>
  );
}

function relTime(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
