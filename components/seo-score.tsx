"use client";
import { useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import type { SeoReport } from "@/lib/types";
import { Gauge } from "@/components/gauge";
import { cn } from "@/lib/utils";

/** The search score of an upload's text: a small dial, what it's tuned for, and the checks on demand. */
export function SeoScore({ seo, className }: { seo: SeoReport; className?: string }) {
  const [open, setOpen] = useState(false);
  const failed = seo.checks.filter((c) => !c.pass);
  const rose = seo.before !== undefined && seo.before < seo.score;
  return (
    <div className={cn("rounded-lg border bg-background/60 px-3 py-2 text-sm", className)}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 text-left" aria-expanded={open}>
        <Gauge value={seo.score} label="SEO" size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-medium">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            Search score {seo.score}
            {rose && <span className="font-normal text-muted-foreground">(was {seo.before})</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {seo.keyword ? `Tuned for “${seo.keyword}”` : "No target keyword"}
            {failed.length ? ` · ${failed.length} thing${failed.length === 1 ? "" : "s"} to improve` : " · every check passes"}
          </span>
        </span>
        {seo.checks.length > 0 && <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />}
      </button>
      {open && (
        <ul className="mt-2 space-y-1 border-t pt-2 text-xs">
          {[...failed, ...seo.checks.filter((c) => c.pass)].map((c) => (
            <li key={c.id} className="flex gap-1.5">
              {c.pass ? <Check className="mt-px size-3.5 shrink-0 text-[var(--gauge-good)]" /> : <X className="mt-px size-3.5 shrink-0 text-[var(--gauge-poor)]" />}
              <span>
                <span className={c.pass ? "text-muted-foreground" : "font-medium"}>{c.label}</span>
                {c.tip && <span className="text-muted-foreground"> · {c.tip}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {seo.note && <p className="mt-1.5 text-xs text-muted-foreground">{seo.note}</p>}
    </div>
  );
}
