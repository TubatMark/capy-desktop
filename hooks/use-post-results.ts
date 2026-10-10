"use client";
import { useCallback, useEffect, useState } from "react";
import type { MetricsRefresh } from "@/lib/performance";
import type { JobState } from "@/lib/types";

export type ResultsState = "loading" | "ready" | "disconnected" | "error";

/** Saved YouTube results for posted clips (read from capy's local cache; "refresh" asks YouTube again). */
export function usePostResults() {
  const [data, setData] = useState<MetricsRefresh | null>(null);
  const [state, setState] = useState<ResultsState>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (init?: RequestInit) => {
    const r = await fetch("/api/channel/performance", {
      ...init,
      headers: { "Content-Type": "application/json" },
    });
    if (r.status === 401) {
      setState("disconnected");
      return;
    }
    if (!r.ok) throw Error("Couldn't load results right now.");
    setData(await r.json());
    setState("ready");
    setError(null);
  }, []);

  useEffect(() => {
    read().catch((e) => {
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [read]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await read({
        method: "POST",
        body: JSON.stringify({ action: "refresh" }),
      });
    } catch {
      setError("Couldn't get new numbers from YouTube. Try again in a bit.");
    } finally {
      setBusy(false);
    }
  }, [read]);

  return { data, state, busy, error, refresh };
}

/** The YouTube channel each source video came from, by job id (loaded once). */
export function useSourceChannels() {
  const [channels, setChannels] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    fetch("/api/jobs")
      .then((r) => (r.ok ? r.json() : []))
      .then((jobs: JobState[]) => {
        if (!live || !Array.isArray(jobs)) return;
        const m = new Map<string, string>();
        for (const j of jobs) {
          const name = j.channel ?? j.automation?.channelName;
          if (name) m.set(j.id, name);
        }
        setChannels(m);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return channels;
}
