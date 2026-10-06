"use client";
import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/hooks/use-job";
import { ago, num } from "@/components/channel/format";
import { toneOf } from "@/components/gauge";
import type { Keyword, KeywordResearch } from "@/lib/types";

const SOURCE: Record<Keyword["sources"][number], string> = { autocomplete: "People type it", ranking: "In what ranks", yours: "Finds you now" };

/** Keyword research: what people type, what ranks for it, and the tags those videos share. */
export function KeywordsPanel({ initial, hint }: { initial?: string; hint?: string }) {
  const [q, setQ] = useState(initial ?? "");
  const [res, setRes] = useState<KeywordResearch | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function run(topic: string) {
    if (topic.trim().length < 2) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await api<KeywordResearch>(`/api/channel/keywords?q=${encodeURIComponent(topic.trim())}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (initial) {
      setQ(initial);
      void run(initial);
    }
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  async function copy(text: string, id: string) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 1400);
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={hint ?? "A topic, e.g. bedtime story for toddlers"} className="pl-9" aria-label="Topic to research" />
        </div>
        <Button type="submit" disabled={busy || q.trim().length < 2}>
          {busy ? <Loader2 className="animate-spin" /> : <Search />} Research
        </Button>
      </form>
      {err && <p className="text-sm text-red-700">{err}</p>}
      {!res && !busy && (
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">
          Type what a video is about. capy asks YouTube what people type after it, looks at the videos that rank for it, and adds the searches that already bring your channel viewers. New
          uploads use the same research automatically.
        </p>
      )}

      {res && (
        <div className="space-y-6">
          {res.notes.length > 0 && <p className="text-xs text-muted-foreground">{res.notes.join(" ")}</p>}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <section className="space-y-2">
              <h3 className="font-semibold">Searches to target</h3>
              {res.keywords.length ? (
                <ol className="divide-y rounded-xl border bg-card">
                  {res.keywords.slice(0, 20).map((k) => (
                    <li key={k.term} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{k.term}</p>
                        <p className="text-xs text-muted-foreground">
                          {k.sources.map((s) => SOURCE[s]).join(" · ")}
                          {k.views ? ` · ${num(k.views)} views to you` : ""}
                        </p>
                      </div>
                      <div className="flex w-28 shrink-0 items-center gap-2" title={`Strength ${k.score} of 100`}>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--gauge-track)]">
                          <div className="h-full rounded-full" style={{ width: `${k.score}%`, background: `var(--gauge-${toneOf(k.score)})` }} />
                        </div>
                        <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{k.score}</span>
                      </div>
                      <button type="button" onClick={() => void copy(k.term, k.term)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Copy ${k.term}`}>
                        {copied === k.term ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">YouTube had no suggestions for this. Try a broader topic.</p>
              )}
            </section>

            <div className="space-y-6">
              {res.tags.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold">Tags the top videos share</h3>
                    <Button size="sm" variant="ghost" onClick={() => void copy(res.tags.join(", "), "tags")}>
                      {copied === "tags" ? <Check /> : <Copy />} Copy all
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {res.tags.slice(0, 24).map((t) => (
                      <span key={t} className="rounded-md bg-secondary px-2 py-0.5 text-xs">
                        {t}
                      </span>
                    ))}
                  </div>
                </section>
              )}
              <section className="space-y-2">
                <h3 className="font-semibold">What ranks for “{res.seed}”</h3>
                {res.ranking.length ? (
                  <ol className="space-y-2.5">
                    {res.ranking.map((v, i) => (
                      <li key={v.id} className="flex gap-3">
                        <span className="w-4 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {v.thumb ? <img src={v.thumb} alt="" className="aspect-video w-24 shrink-0 rounded-md object-cover" /> : <div className="aspect-video w-24 shrink-0 rounded-md bg-muted" />}
                        <div className="min-w-0">
                          <a href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer" className="line-clamp-2 text-sm font-medium hover:underline">
                            {v.title}
                          </a>
                          <p className="text-xs text-muted-foreground">
                            {v.channel} · {num(v.views)} views{v.publishedAt ? ` · ${ago(v.publishedAt)}` : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">No ranking videos for this search right now.</p>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
