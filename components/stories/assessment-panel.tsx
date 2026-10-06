"use client";
import { Check, Gauge as GaugeIcon, Loader2, RefreshCw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Gauge } from "@/components/gauge";
import type { StoryAssessment, StoryState } from "@/lib/types";

const VERDICT: Record<StoryAssessment["verdict"], { line: string; cls: string }> = {
  ready: { line: "Ready for you", cls: "text-[var(--gauge-good)]" },
  fix: { line: "Worth fixing first", cls: "text-amber-700" },
  block: { line: "Not safe to publish as is", cls: "text-[var(--gauge-poor)]" },
};
const SCORES: { key: keyof StoryAssessment["scores"]; label: string }[] = [
  { key: "hook", label: "Hook" },
  { key: "retention", label: "Retention" },
  { key: "search", label: "Search" },
  { key: "safety", label: "Kid-safe" },
  { key: "production", label: "Production" },
];

/**
 * The assessor's look at a stage: overall dial, five scores, what works and what to fix. While it's looking, or
 * hasn't yet, it says so; the story reaches To do only after this.
 */
export function AssessmentPanel({ story, stage, busy, onFix, onAgain }: { story: StoryState; stage: StoryAssessment["stage"]; busy: string | null; onFix?: (notes: string[]) => void; onAgain: () => void }) {
  const a = story.assessments?.[stage];
  const looking = story.assessing === stage;

  if (!a || looking)
    return (
      <section className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
        <Loader2 className="size-4 animate-spin text-primary" />
        <span className="text-pretty">
          {looking ? `The assessor is looking at the ${stage === "script" ? "script" : "finished video"}: hook, retention, search, kid-safety and production.` : "Waiting for the assessor…"}
        </span>
      </section>
    );

  if (a.error)
    return (
      <section className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
        <GaugeIcon className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1">The assessor couldn&apos;t run ({a.error}).</span>
        <Button size="sm" variant="outline" onClick={onAgain} disabled={busy !== null}>
          {busy === "assess" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again
        </Button>
      </section>
    );

  const v = VERDICT[a.verdict];
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <div className="flex items-center gap-4">
          <Gauge value={a.overall} label="Overall" />
          <div className="max-w-56 space-y-1">
            <p className="text-xs text-muted-foreground">Assessor · {stage === "script" ? "the script" : "the finished video"}</p>
            <p className={`text-lg font-semibold ${v.cls}`}>{v.line}</p>
          </div>
        </div>
        <ul className="grid flex-1 grid-cols-5 gap-2" aria-label="Scores">
          {SCORES.map((s) => (
            <li key={s.key} className="flex min-w-0 flex-col items-center gap-1">
              <Gauge value={a.scores[s.key]} label={s.label} size="sm" />
              <span className="truncate text-xs text-muted-foreground">{s.label}</span>
            </li>
          ))}
        </ul>
      </div>
      {(a.strengths.length > 0 || a.fixes.length > 0) && (
        <div className="grid gap-4 border-t pt-4 md:grid-cols-2">
          {a.fixes.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">To make it better</p>
              <ol className="space-y-1 text-sm">
                {a.fixes.map((f, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{f.area}</span>
                    <span className="min-w-0 text-pretty">{f.note}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {a.strengths.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">What works</p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {a.strengths.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-[var(--gauge-good)]" />
                    <span className="text-pretty">{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {onFix && a.fixes.length > 0 && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onFix(a.fixes.filter((f) => f.area !== "search").map((f) => f.note))}>
            {busy === "rewrite" ? <Loader2 className="animate-spin" /> : <Wand2 />} Fix these with AI
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onAgain}>
          {busy === "assess" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Assess again
        </Button>
      </div>
    </section>
  );
}
