"use client";
import { useEffect, useRef, useState } from "react";
import type { JobState, Word } from "@/lib/types";

/** Live job state over SSE, with a fetch fallback. */
export function useJob(id: string | null) {
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    fetch(`/api/jobs/${id}`)
      .then(async (r) => {
        if (!alive) return;
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
        setJob(await r.json());
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    const es = new EventSource(`/api/jobs/${id}/events`);
    es.onmessage = (ev) => {
      if (!alive) return;
      try {
        setJob(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    return () => {
      alive = false;
      es.close();
    };
  }, [id]);

  return { job, error, setJob };
}

export function useWords(id: string | null, ready: boolean) {
  const [words, setWords] = useState<Word[] | null>(null);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !ready || loaded.current === id) return;
    loaded.current = id;
    fetch(`/api/jobs/${id}/words`)
      .then((r) => r.json())
      .then(setWords)
      .catch(() => setWords([]));
  }, [id, ready]);
  return words;
}

/** English caption words for a translated video; refetched when `version` (the translated ranges) changes. */
export function useCaptionWords(id: string | null, version: string) {
  const [words, setWords] = useState<Word[] | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    fetch(`/api/jobs/${id}/caption-words`)
      .then((r) => r.json())
      .then((w) => live && setWords(Array.isArray(w) ? w : []))
      .catch(() => live && setWords([]));
    return () => {
      live = false;
    };
  }, [id, version]);
  return words;
}

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body as T;
}
