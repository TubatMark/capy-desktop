"use client";
import { useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { StoryPlan } from "@/lib/types";
import { cn } from "@/lib/utils";

const BEATS: { key: keyof StoryPlan["beats"]; label: string }[] = [
  { key: "setup", label: "Setup" },
  { key: "problem", label: "Problem" },
  { key: "turn", label: "Turn" },
  { key: "ending", label: "Ending" },
];

/** What the story was planned for before a word was written: the search, the hook, the shape. */
export function PlanCard({ plan }: { plan: StoryPlan }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border bg-card">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left">
        <span className="font-semibold">The plan</span>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5 text-xs">
          <Search className="size-3" /> {plan.keyword || "no keyword"}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {plan.pages} pages · ~{plan.targetSeconds}s
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">Opens with “{plan.hook.line}”</span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-4 border-t px-4 py-4 text-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">The hook (page 1, also the cover)</p>
              <p className="font-medium text-pretty">“{plan.hook.line}”</p>
              <p className="text-pretty text-muted-foreground">{plan.hook.picture}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Why parents pick it and play it again</p>
              <p className="text-pretty">{plan.parentsWhy || "—"}</p>
              {plan.refrain && (
                <p className="text-pretty text-muted-foreground">
                  Refrain: <span className="text-foreground">“{plan.refrain}”</span>
                </p>
              )}
            </div>
          </div>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {BEATS.map((b, i) => (
              <li key={b.key} className="space-y-1">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="grid size-5 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold tabular-nums text-foreground">{i + 1}</span>
                  {b.label}
                </p>
                <p className="text-pretty">{plan.beats[b.key] || "—"}</p>
              </li>
            ))}
          </ol>
          {(plan.searchTerms.length > 0 || plan.notes?.length) && (
            <div className="space-y-1.5">
              {plan.searchTerms.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Also targets</span>
                  {plan.searchTerms.map((t) => (
                    <span key={t} className="rounded-md bg-secondary px-2 py-0.5 text-xs">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {plan.notes?.length ? <p className="text-xs text-muted-foreground">{plan.notes.join(" ")}</p> : null}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
