"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Loader2, PenLine, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/hooks/use-job";
import type { StorySeries, StoryState } from "@/lib/types";
import { StatusChip } from "@/components/stories/status-chip";

export function SeriesView({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<{ series: StorySeries; stories: StoryState[] } | null>(null);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/stories/series/${id}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  // keep polling while characters are being drawn or a story is working
  const working = !!data && (data.series.characters.some((c) => c.status === "drawing") || data.stories.some((s) => ["planning", "writing", "illustrating", "rendering"].includes(s.status) || !!s.assessing));
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [working, load]);

  async function write(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const st = await api<StoryState>(`/api/stories/series/${id}/stories`, { method: "POST", body: JSON.stringify({ brief }) });
      router.push(`/stories/${id}/${st.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (!data)
    return err ? (
      <p className="text-sm text-red-600">{err}</p>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );
  const s = data.series;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Link href="/stories" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Stories
        </Link>
        <h1 className="text-2xl font-semibold">{s.title}</h1>
        <p className="text-sm text-muted-foreground">
          Ages {s.ageBand} · {s.tone}
          {s.values.length ? ` · about ${s.values.join(", ")}` : ""}
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="font-semibold">Characters</h2>
        <div className="flex flex-wrap gap-4">
          {s.characters.map((c) => (
            <div key={c.id} className="w-40 space-y-2 rounded-xl border bg-card p-3">
              <div className="grid aspect-square place-items-center overflow-hidden rounded-lg bg-background">
                {c.status === "drawing" ? (
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                ) : c.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.imageUrl} alt={c.name} className="size-full object-contain" />
                ) : (
                  <AlertTriangle className="size-6 text-amber-600" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium">{c.name}</p>
                <p className="line-clamp-2 text-xs text-muted-foreground" title={c.description}>
                  {c.status === "drawing" ? "Drawing…" : c.status === "error" ? c.error : c.description}
                </p>
              </div>
              {c.status !== "drawing" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={async () => {
                    await api(`/api/stories/series/${id}/characters/${c.id}`, { method: "POST" }).catch((e) => setErr(String(e.message ?? e)));
                    void load();
                  }}
                >
                  <RefreshCw /> Draw again
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      <form onSubmit={write} className="space-y-3 rounded-xl border bg-card p-5">
        <h2 className="font-semibold">New story</h2>
        <Textarea
          rows={2}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={`What happens? e.g. "${s.characters[0]?.name ?? "Pip"} learns to share" or "a rainy day turns into an adventure"`}
        />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button type="submit" disabled={busy || brief.trim().length < 3}>
          {busy ? <Loader2 className="animate-spin" /> : <PenLine />} Write the story
        </Button>
        <p className="text-xs text-muted-foreground">AI writes it, a kid-safety reviewer checks it, and you can edit every page before anything is drawn.</p>
      </form>

      {data.stories.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Stories</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.stories.map((st) => {
              const cover = st.video?.coverUrl ?? st.pages.find((p) => p.imageUrl)?.imageUrl;
              return (
                <Link key={st.id} href={`/stories/${id}/${st.id}`} className="group flex gap-3 rounded-xl border bg-card p-3 hover:shadow-[0_6px_20px_-8px_oklch(0.24_0.03_45_/_30%)]">
                  <div className="aspect-[9/16] w-16 shrink-0 overflow-hidden rounded-md bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {cover && <img src={cover} alt="" className="size-full object-cover" />}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="truncate font-medium group-hover:underline">{st.title}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{st.brief}</p>
                    <StatusChip story={st} />
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
