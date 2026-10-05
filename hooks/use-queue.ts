"use client";
import { useCallback, useEffect, useState } from "react";
import type { QueueEntry, QueueSummary } from "@/lib/types";

export interface QueueData {
  entries: QueueEntry[];
  summary: QueueSummary;
  /** Next free slot for the connected platforms (Unix ms). */
  nextFree?: number;
  audienceTz: string;
}

/** The posting queue, refreshed every 5 s while the tab is visible. */
export function useQueue() {
  const [data, setData] = useState<QueueData | null>(null);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/queue");
      if (r.ok) setData(await r.json());
    } catch {
      /* offline for a moment */
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);
  return { data, refresh };
}

export function fmtSlot(at: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(at));
}
