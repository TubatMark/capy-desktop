"use client";
import { useMemo, useState } from "react";
import { queueGroup } from "@/lib/queue-source";
import { SHORT_COLUMNS, entryTime, postThumb, shortColumn, type ShortColumn } from "@/lib/queue-calendar";
import type { QueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PostThumb } from "./post-bits";

const TONE: Record<ShortColumn, { top: string; dot: string; edge: string }> = {
  waiting: { top: "border-t-amber-500", dot: "bg-amber-500", edge: "border-l-amber-500" },
  scheduled: { top: "border-t-cyan-600", dot: "bg-cyan-600", edge: "border-l-cyan-600" },
  posting: { top: "border-t-violet-500", dot: "bg-violet-500", edge: "border-l-violet-500" },
  posted: { top: "border-t-emerald-600", dot: "bg-emerald-600", edge: "border-l-emerald-600" },
  attention: { top: "border-t-red-600", dot: "bg-red-600", edge: "border-l-red-600" },
  skipped: { top: "border-t-stone-400", dot: "bg-stone-400", edge: "border-l-stone-400" },
};
/** Enough to scroll through without a column of 100 slowing the page. */
const PAGE = 24;

const fmt = (at: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);

const sinceOriginal = (at: number, now: number) => {
  const h = Math.max(0, Math.round((now - at) / 3_600_000));
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

export function ShortKanban({ entries, tz, onOpen }: { entries: QueueEntry[]; tz: string; onOpen: (group: string, column: ShortColumn) => void }) {
  const [more, setMore] = useState<Partial<Record<ShortColumn, number>>>({});
  const nowAt = Date.now();
  const columns = useMemo(() => {
    const groups = new Map<string, QueueEntry[]>();
    for (const e of entries) groups.set(queueGroup(e), [...(groups.get(queueGroup(e)) ?? []), e]);
    const out = new Map<ShortColumn, { group: string; entries: QueueEntry[]; at: number }[]>();
    for (const [group, es] of groups) {
      const col = shortColumn(es);
      out.set(col, [...(out.get(col) ?? []), { group, entries: es, at: Math.max(...es.map(entryTime)) }]);
    }
    for (const [col, cards] of out) cards.sort((a, b) => (col === "scheduled" || col === "waiting" ? a.at - b.at : b.at - a.at));
    return out;
  }, [entries]);

  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-2">
      <div className="grid min-w-[1080px] grid-cols-6 gap-3">
        {SHORT_COLUMNS.map((col) => {
          const cards = columns.get(col.id) ?? [];
          const shown = more[col.id] ?? PAGE;
          return (
            <section key={col.id} aria-label={col.label} className={cn("flex min-h-64 flex-col gap-2 rounded-xl border-t-4 bg-muted/50 p-2", TONE[col.id].top)}>
              <header className="px-1 py-1">
                <h2 className="flex items-center justify-between text-sm font-medium">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className={cn("size-2 rounded-full", TONE[col.id].dot)} /> {col.label}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
                </h2>
                <p className="text-xs text-muted-foreground">{col.hint}</p>
              </header>
              {cards.slice(0, shown).map((card) => (
                <button
                  key={card.group}
                  type="button"
                  onClick={() => onOpen(card.group, col.id)}
                  className={cn("w-full space-y-1.5 rounded-lg border border-l-4 bg-card p-2 text-left shadow-sm transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-primary", TONE[col.id].edge)}
                >
                  <PostThumb src={postThumb(card.entries)} className="mx-auto w-24" />
                  <p className="line-clamp-3 text-xs font-medium">{card.entries[0]!.clipTitle}</p>
                  {col.id !== "waiting" && col.id !== "skipped" && <p className="text-[11px] text-muted-foreground">{fmt(card.at, tz)}</p>}
                  {card.entries[0]!.sourceUploadedAt !== undefined && col.id !== "posted" && col.id !== "skipped" && (
                    <p className="text-[11px] text-muted-foreground">Original {sinceOriginal(card.entries[0]!.sourceUploadedAt!, nowAt)} ago</p>
                  )}
                </button>
              ))}
              {cards.length > shown && (
                <button type="button" className="rounded-md py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent" onClick={() => setMore((m) => ({ ...m, [col.id]: shown + PAGE }))}>
                  Show {Math.min(PAGE, cards.length - shown)} more
                </button>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
