"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Film, KeyRound, ListChecks, Loader2, Smartphone } from "lucide-react";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import type { TodoTask } from "@/lib/types";
import { cn } from "@/lib/utils";

const ICON: Record<TodoTask["kind"], typeof Film> = {
  post: Smartphone,
  video: Film,
  account: KeyRound,
  work: AlertTriangle,
  queue: CalendarClock,
};
const ACTION: Record<TodoTask["kind"], string> = { post: "Open Short form", video: "Open Long-form", account: "Open Settings", work: "Open", queue: "Open Short form" };
const TONE: Record<TodoTask["tone"], string> = {
  block: "bg-[var(--gauge-poor)]/12 text-[var(--gauge-poor)]",
  action: "bg-primary/15 text-foreground",
  warn: "bg-amber-500/15 text-amber-800",
};

/** Only what capy can't sort out by itself: one list, most urgent first, and usually empty. */
export function TodoView() {
  const [tasks, setTasks] = useState<TodoTask[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(
    () =>
      fetch("/api/todo")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: { tasks: TodoTask[] }) => {
          setTasks(d.tasks);
          setErr(null);
        })
        .catch((e) => setErr(e instanceof Error ? e.message : String(e))),
    [],
  );
  useVisibleInterval(load, 5000);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ListChecks className="size-6 text-primary" /> To do
        </h1>
        <p className="max-w-2xl text-pretty text-sm text-muted-foreground">capy makes, checks and schedules your videos by itself. Anything it can&apos;t sort out alone lands here, with a link to where you can fix it.</p>
      </div>

      {err && <p className="text-sm text-red-700">{err}</p>}
      {!tasks ? (
        !err && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        )
      ) : tasks.length ? (
        <ol className="divide-y overflow-hidden rounded-xl border bg-card">
          {tasks.map((t) => {
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
          <CheckCircle2 className="mx-auto mb-2 size-6 text-emerald-600" />
          <p className="font-medium">All good, nothing needs you</p>
          <p className="mx-auto mt-1 max-w-md text-pretty text-sm text-muted-foreground">
            capy is carrying on by itself. See what it&apos;s up to in{" "}
            <Link href="/short-form" className="underline underline-offset-2">
              Short form
            </Link>{" "}
            and{" "}
            <Link href="/automation" className="underline underline-offset-2">
              Monitor
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  );
}
