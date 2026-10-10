"use client";
import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  addDays,
  addMonths,
  countKinds,
  fmtDay,
  monthGrid,
  monthOf,
  weekday,
  type DayPost,
  type PostKind,
} from "@/lib/queue-calendar";
import { cn } from "@/lib/utils";
import { KIND, KindMark } from "./post-bits";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDER: PostKind[] = ["posted", "scheduled", "attention"];

/** Month view of the posting plan. Arrow keys move the day, Page Up/Down the month. */
export function QueueCalendar({
  days,
  view,
  selected,
  today,
  tzLabel,
  onView,
  onSelect,
}: {
  days: Map<string, DayPost[]>;
  /** Any day in the month on screen. */
  view: string;
  selected: string;
  today: string;
  tzLabel: string;
  onView: (day: string) => void;
  onSelect: (day: string) => void;
}) {
  const weeks = monthGrid(view);
  const month = monthOf(view);
  const grid = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);

  // keep keyboard focus on the selected day after arrow keys re-render the grid
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    grid.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${selected}"]`)
      ?.focus();
  }, [selected, view]);

  const go = (day: string) => {
    focusNext.current = true;
    if (monthOf(day) !== month) onView(day);
    onSelect(day);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(selected, -1),
      ArrowRight: () => addDays(selected, 1),
      ArrowUp: () => addDays(selected, -7),
      ArrowDown: () => addDays(selected, 7),
      Home: () => addDays(selected, -weekday(selected)),
      End: () => addDays(selected, 6 - weekday(selected)),
      PageUp: () => addMonths(selected, -1),
      PageDown: () => addMonths(selected, 1),
    };
    const f = step[e.key];
    if (!f) return;
    e.preventDefault();
    go(f());
  };

  const monthCounts = countKinds(
    [...days.entries()]
      .filter(([d]) => monthOf(d) === month)
      .flatMap(([, posts]) => posts),
  );

  return (
    <div className="rounded-xl border bg-card p-3 sm:p-4">
      <div className="mb-3 flex items-center gap-1">
        <h3
          className="mr-auto pl-1 text-base font-semibold"
          aria-live="polite"
          id="queue-month"
        >
          {fmtDay(`${month}-01`, { month: "long", year: "numeric" })}
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            focusNext.current = false;
            onView(today);
            onSelect(today);
          }}
        >
          Today
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Previous month"
          onClick={() => onView(addMonths(view, -1))}
        >
          <ChevronLeft />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Next month"
          onClick={() => onView(addMonths(view, 1))}
        >
          <ChevronRight />
        </Button>
      </div>

      <div
        ref={grid}
        role="grid"
        aria-labelledby="queue-month"
        onKeyDown={onKey}
        className="select-none"
      >
        <div role="row" className="grid grid-cols-7 pb-1">
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              role="columnheader"
              aria-label={w}
              className="text-center text-[11px] font-medium text-muted-foreground"
            >
              {w.slice(0, 2)}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div role="row" key={week[0]} className="grid grid-cols-7 gap-1 pb-1">
            {week.map((day) => {
              const posts = days.get(day);
              const c = countKinds(posts);
              const inMonth = monthOf(day) === month;
              const isSel = day === selected;
              const isToday = day === today;
              const parts = ORDER.filter((k) => c[k]).map(
                (k) => `${c[k]} ${KIND[k].label.toLowerCase()}`,
              );
              return (
                <div role="gridcell" key={day} aria-selected={isSel}>
                  <button
                    type="button"
                    data-day={day}
                    tabIndex={isSel ? 0 : -1}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={`${fmtDay(day)}${isToday ? ", today" : ""}: ${parts.length ? parts.join(", ") : "nothing planned"}`}
                    onClick={() => {
                      if (!inMonth) onView(day);
                      onSelect(day);
                    }}
                    className={cn(
                      "flex h-14 w-full flex-col items-start justify-between rounded-lg px-1.5 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:h-16",
                      isSel
                        ? "bg-[var(--ink)] text-[var(--sticker-cream)]"
                        : "hover:bg-accent",
                      !isSel && !inMonth && "text-muted-foreground/60",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-6 place-items-center rounded-full text-xs tabular-nums",
                        isToday && !isSel && "bg-primary font-semibold",
                        isToday && isSel && "font-semibold underline",
                      )}
                    >
                      {Number(day.slice(8))}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      {ORDER.filter((k) => c[k]).map((k) => (
                        <span
                          key={k}
                          className="inline-flex items-center gap-0.5 text-[10px] font-medium leading-none tabular-nums"
                        >
                          <KindMark
                            kind={k}
                            className={cn(
                              isSel &&
                                k === "scheduled" &&
                                "border-[var(--sticker-cream)] bg-transparent",
                            )}
                          />
                          {c[k]}
                        </span>
                      ))}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        {ORDER.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <KindMark kind={k} className="size-2" />
            {KIND[k].label}
            <span className="font-medium tabular-nums text-foreground">
              {monthCounts[k]}
            </span>
          </span>
        ))}
        <span className="basis-full text-[11px]">
          Counts for this month. Days follow {tzLabel} time.
        </span>
      </div>
    </div>
  );
}
