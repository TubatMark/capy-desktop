"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, BookOpen, CalendarClock, Clapperboard, Image as ImageIcon, ListChecks, Loader2, Send, Wrench } from "lucide-react";
import { Gauge } from "@/components/gauge";
import type { TodoTask } from "@/lib/types";
import { cn } from "@/lib/utils";

type Data = { tasks: TodoTask[]; assessing: { id: string; seriesId: string; title: string; stage: "script" | "video" }[]; waiting: number };

const ICON: Record<TodoTask["kind"], typeof BookOpen> = {
  script: BookOpen,
  pictures: ImageIcon,
  video: Clapperboard,
  send: Send,
  fix: Wrench,
  queue: CalendarClock,
  error: AlertTriangle,
};
const ACTION: Record<TodoTask["kind"], string> = { script: "Review", pictures: "Open", video: "Open", send: "Watch", fix: "Fix", queue: "Open Queue", error: "Open" };
const TONE: Record<TodoTask["tone"], string> = {
  block: "bg-[var(--gauge-poor)]/12 text-[var(--gauge-poor)]",
  action: "bg-primary/15 text-foreground",
  warn: "bg-amber-500/15 text-amber-800",
};

/** Everything waiting for the user, after the assessor has looked: one list, most urgent first. */
export function TodoView() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/todo")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: Data) => live && (setData(d), setErr(null)))
        .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    void load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ListChecks className="size-6 text-primary" /> To do
        </h1>
        <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
          What needs you now. Stories land here only after the assessor has checked them for hook, retention, search, kid-safety and production; clips land here when
          they&apos;re waiting in Queue.
        </p>
      </div>

      {err && <p className="text-sm text-red-700">{err}</p>}
      {!data ? (
        !err && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        )
      ) : (
        <>
          {data.tasks.length ? (
            <ol className="divide-y overflow-hidden rounded-xl border bg-card">
              {data.tasks.map((t) => {
                const Icon = ICON[t.kind];
                return (
                  <li key={t.id}>
                    <Link href={t.href} className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/40">
                      <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", TONE[t.tone])}>
                        <Icon className="size-[18px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-pretty">{t.title}</span>
                        {t.detail && <span className="line-clamp-2 text-sm text-pretty text-muted-foreground">{t.detail}</span>}
                      </span>
                      {t.overall !== undefined && <Gauge value={t.overall} label="Assessor score" size="sm" className="shrink-0" />}
                      <span className="hidden shrink-0 items-center gap-1 text-sm font-medium text-muted-foreground group-hover:text-foreground sm:inline-flex">
                        {ACTION[t.kind]} <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="rounded-xl border bg-card px-5 py-8 text-center">
              <p className="font-medium">Nothing needs you right now</p>
              <p className="mx-auto mt-1 max-w-md text-pretty text-sm text-muted-foreground">
                Write a story in{" "}
                <Link href="/stories" className="underline underline-offset-2">
                  Stories
                </Link>{" "}
                or add a channel in{" "}
                <Link href="/automation" className="underline underline-offset-2">
                  Monitor
                </Link>
                ; what they make shows up here once it&apos;s been checked.
              </p>
            </div>
          )}

          {data.assessing.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">The assessor is looking at</h2>
              <ul className="space-y-1.5 text-sm">
                {data.assessing.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                    <Link href={`/stories/${a.seriesId}/${a.id}`} className="hover:text-foreground hover:underline">
                      “{a.title}”
                    </Link>
                    <span className="text-xs">({a.stage === "script" ? "script" : "video"})</span>
                  </li>
                ))}
              </ul>
              {data.waiting > data.assessing.length && <p className="text-xs text-muted-foreground">{data.waiting - data.assessing.length} more in line.</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
