"use client";
import { useCallback, useEffect, useState } from "react";
import type { QueueEntry, QueueSummary } from "@/lib/types";

export interface QueueData {
  entries: QueueEntry[];
  capabilities?: import("@/server/platform-capabilities").DestinationCapabilities[];
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
    const t = setInterval(
      () => document.visibilityState === "visible" && void refresh(),
      5000,
    );
    return () => clearInterval(t);
  }, [refresh]);
  return { data, refresh };
}

export function fmtSlot(at: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(at));
}

/** Review count, next post and watched creators for the navigation; refreshed every 15 s. */
export function useQueueSummary() {
  const [s, setS] = useState<
    (QueueSummary & { watching?: number; todo?: number }) | null
  >(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/queue/summary")
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => live && v && setS(v))
        .catch(() => {});
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return s;
}
