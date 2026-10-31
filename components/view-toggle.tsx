"use client";
import { useEffect, useState } from "react";
import { CalendarDays, Columns3 } from "lucide-react";
import { cn } from "@/lib/utils";

export type BoardView = "kanban" | "calendar";

/** The chosen view is remembered per page; a ?view= link overrides it. */
export function useBoardView(page: string) {
  const [view, setView] = useState<BoardView>("kanban");
  const key = `capy.view.${page}`;
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get("view");
    if (asked === "kanban" || asked === "calendar") return setView(asked);
    try {
      const saved = localStorage.getItem(key);
      if (saved === "kanban" || saved === "calendar") setView(saved);
    } catch {
      /* private mode */
    }
  }, [key]);
  const choose = (next: BoardView) => {
    setView(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* private mode */
    }
  };
  return [view, choose] as const;
}

const OPTIONS: { id: BoardView; label: string; icon: typeof Columns3 }[] = [
  { id: "kanban", label: "Kanban", icon: Columns3 },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
];

export function ViewToggle({ view, onChange }: { view: BoardView; onChange: (view: BoardView) => void }) {
  return (
    <nav aria-label="View" className="inline-flex rounded-lg border bg-card p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={view === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            view === o.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <o.icon className="size-4" /> {o.label}
        </button>
      ))}
    </nav>
  );
}
