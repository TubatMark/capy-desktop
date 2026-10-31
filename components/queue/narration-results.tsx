"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Mic } from "lucide-react";
import { api } from "@/hooks/use-job";
import type { ShortTestGroup, ShortTestState, ShortTestSummary } from "@/lib/shorts-test";
import { cn } from "@/lib/utils";

export type ShortTestReport = ShortTestState & { narrate: "half" | "all" | "off"; narrateManual?: "all" | "half"; summary: ShortTestSummary };

/** How narrated Shorts are doing against plain ones. The choice itself lives in Settings. */
export function NarrationResults() {
  const [test, setTest] = useState<ShortTestReport | null>(null);
  useEffect(() => {
    void api<{ shortsTest: ShortTestReport }>("/api/longform?automation=1")
      .then((r) => setTest(r.shortsTest))
      .catch(() => {});
  }, []);
  if (!test) return null;
  const row = (label: string, g: ShortTestGroup, tone: string) => (
    <div className={cn("rounded-lg p-3 text-sm", tone)}>
      <p className="font-medium">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{g.feedViews.toLocaleString("en-US")}</p>
      <p className="text-xs">
        feed views from {g.posts} Shorts. {g.reachedFeed} reached the feed, median {g.medianFeedViews.toLocaleString("en-US")}.
        {g.stayedToWatch !== undefined ? ` ${Math.round(g.stayedToWatch * 100)}% stayed to watch.` : ""}
      </p>
    </div>
  );
  return (
    <section className="space-y-3 rounded-xl border p-4" aria-label="Narrated Shorts">
      <h2 className="flex items-center gap-2 font-medium">
        <Mic className="size-4" /> Narrated Shorts
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {row("Narrated", test.summary.narrated, "bg-violet-500/10")}
        {row("Plain", test.summary.plain, "bg-slate-500/10")}
      </div>
      <p className="text-sm">{test.summary.verdict}</p>
      <p className="text-xs text-muted-foreground">
        Choose how many are narrated in{" "}
        <Link href="/settings#automation" className="underline underline-offset-2">
          Settings
        </Link>
        .
      </p>
    </section>
  );
}
