"use client";
import { useCallback, useRef, useState } from "react";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import type { QueueEntry, QueueSummary } from "@/lib/types";

export interface QueueData {
  entries: QueueEntry[];
  capabilities?: import("@/server/platform-capabilities").DestinationCapabilities[];
  summary: QueueSummary;
  /** Next free slot for the connected platforms (Unix ms). */
  nextFree?: number;
  audienceTz: string;
}

/** The posting queue (or just one clip's posts), refreshed every 5 s while the window is visible. */
export function useQueue(clip?: { jobId: string; n: number }) {
  const [data, setData] = useState<QueueData | null>(null);
  const url = clip ? `/api/queue?jobId=${encodeURIComponent(clip.jobId)}&n=${clip.n}` : "/api/queue";
  // an unchanged response keeps the same object, so the page's memos don't recompute
  const last = useRef("");
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const text = await r.text();
      if (text === last.current) return;
      last.current = text;
      setData(JSON.parse(text));
    } catch {
      /* offline for a moment */
    }
  }, [url]);
  useVisibleInterval(refresh, 5000);
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

/** Review count, next post and To do count for the navigation; refreshed every 15 s while the window is visible. */
export function useQueueSummary() {
  const [s, setS] = useState<(QueueSummary & { watching?: number; todo?: number }) | null>(null);
  useVisibleInterval(
    () =>
      fetch("/api/queue/summary")
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => v && setS(v))
        .catch(() => {}),
    15_000,
  );
  return s;
}
