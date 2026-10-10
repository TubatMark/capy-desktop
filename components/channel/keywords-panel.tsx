"use client";
import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/hooks/use-job";
import { ago, num } from "@/components/channel/format";
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
      const result = await api<KeywordResearch>(`/api/channel/keywords?q=${encodeURIComponent(topic.trim())}`);
      setRes({ ...result, keywords: result.rawVersion === 1 ? result.keywords : [], tags: [] });
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
          View raw autocomplete suggestions and YouTube search results. Automatic drafts use separate local editorial checks.
        </p>
      )}

      {res && (
        <div className="space-y-6">
          {res.notes.length > 0 && <p className="text-xs text-muted-foreground">{res.notes.join(" ")}</p>}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <section className="space-y-2">
              <h3 className="font-semibold">Autocomplete suggestions</h3>
              {res.keywords.length ? (
                <ol className="divide-y rounded-xl border bg-card">
                  {res.keywords.slice(0, 20).map((k) => (
                    <li key={k.term} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{k.term}</p>
                        <p className="text-xs text-muted-foreground">
                          {k.sources.map((s) => SOURCE[s]).join(" · ")}
                        </p>
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
              <section className="space-y-2">
                <h3 className="font-semibold">YouTube results for “{res.seed}”</h3>
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
                            {v.channel} · {v.views === undefined ? "Views unavailable" : `${num(v.views)} views`}{v.publishedAt ? ` · ${ago(v.publishedAt)}` : ""}
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
