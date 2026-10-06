"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { KeyRound, Loader2, MonitorPlay, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Gauge } from "@/components/gauge";
import { ViewsChart } from "@/components/channel/views-chart";
import { VideosTable } from "@/components/channel/videos-table";
import { KeywordsPanel } from "@/components/channel/keywords-panel";
import { ago, num, sourceName } from "@/components/channel/format";
import { api } from "@/hooks/use-job";
import type { ChannelSnapshot, ChannelVideo } from "@/lib/types";

type State = { access: { connected: boolean; read: boolean; analytics: boolean; edit: boolean }; snapshot: ChannelSnapshot | null; error?: string };

export function ChannelView() {
  const [data, setData] = useState<State | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState("overview");
  const [topic, setTopic] = useState<string | undefined>();

  const load = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      setData(await api<State>(`/api/channel${refresh ? "?refresh=1" : ""}`));
    } catch (e) {
      setData((d) => ({ access: d?.access ?? { connected: true, read: true, analytics: false, edit: false }, snapshot: d?.snapshot ?? null, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading your channel…
      </p>
    );

  if (!data.access.connected)
    return (
      <div className="space-y-4">
        <Title />
        <div className="max-w-xl space-y-3 rounded-xl border bg-card p-5">
          <p className="font-medium">Connect your YouTube channel</p>
          <p className="text-sm text-pretty text-muted-foreground">
            capy reads your channel&apos;s videos and numbers, shows the searches that bring viewers, and tunes every upload for YouTube search. It uses your own free Google
            developer app, the same one that posts your clips.
          </p>
          <Button asChild>
            <Link href="/settings#accounts">
              <KeyRound /> Connect in Settings
            </Link>
          </Button>
        </div>
      </div>
    );

  const s = data.snapshot;
  if (!s)
    return (
      <div className="space-y-4">
        <Title />
        <p className="text-sm text-red-700">{data.error ?? "Couldn't load the channel."}</p>
        <Button variant="outline" onClick={() => void load(true)} disabled={refreshing}>
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Try again
        </Button>
      </div>
    );

  const replaceVideo = (v: ChannelVideo) => setData({ ...data, snapshot: { ...s, videos: s.videos.map((x) => (x.id === v.id ? { ...x, ...v } : x)) } });
  const subsNet = s.analytics ? s.analytics.days.reduce((n, d) => n + d.subsGained - d.subsLost, 0) : undefined;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {s.channel.avatar ? <img src={s.channel.avatar} alt="" className="size-14 rounded-full border bg-muted object-cover" /> : <div className="grid size-14 place-items-center rounded-full bg-muted text-lg font-semibold">{s.channel.title.slice(0, 1)}</div>}
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{s.channel.title}</h1>
          <p className="text-sm tabular-nums text-muted-foreground">
            {[s.channel.handle, `${num(s.channel.subscribers)} subscribers`, subsNet !== undefined ? `${subsNet >= 0 ? "+" : ""}${subsNet} in 28 days` : null, `${num(s.channel.videos)} videos`, `${num(s.channel.views)} views`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Updated {ago(s.fetchedAt)}</span>
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
            {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
          </Button>
        </div>
      </header>

      {data.error && <p className="text-sm text-red-700">Couldn&apos;t refresh: {data.error}</p>}
      {(!data.access.analytics || !data.access.edit) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-950">
          <KeyRound className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 text-pretty">
            Reconnect YouTube once to unlock {[!data.access.analytics && "watch time and the searches that found you", !data.access.edit && "one-click SEO fixes for old videos"].filter(Boolean).join(", and ")}.
          </span>
          <Button asChild size="sm" variant="outline">
            <Link href="/settings#accounts">Reconnect</Link>
          </Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="videos">Videos</TabsTrigger>
          <TabsTrigger value="keywords">Keywords</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-5">
          <Overview
            s={s}
            onTopic={(t) => {
              setTopic(t);
              setTab("keywords");
            }}
          />
        </TabsContent>
        <TabsContent value="videos" className="mt-5">
          <VideosTable videos={s.videos} canEdit={data.access.edit} onUpdated={replaceVideo} />
        </TabsContent>
        <TabsContent value="keywords" className="mt-5" forceMount hidden={tab !== "keywords"}>
          <KeywordsPanel initial={topic} hint={s.analytics?.searches[0] ? `A topic, e.g. ${s.analytics.searches[0].term}` : undefined} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Title() {
  return (
    <h1 className="flex items-center gap-2 text-2xl font-semibold">
      <MonitorPlay className="size-6 text-primary" /> Channel
    </h1>
  );
}

function Overview({ s, onTopic }: { s: ChannelSnapshot; onTopic: (t: string) => void }) {
  const a = s.analytics;
  const scored = s.videos.filter((v) => typeof v.seo === "number");
  const seo = scored.length ? scored.reduce((n, v) => n + v.seo!, 0) / scored.length : null;
  const sourceTotal = a?.sources.reduce((n, x) => n + x.views, 0) ?? 0;
  const search = a && sourceTotal ? ((a.sources.find((x) => x.source === "YT_SEARCH")?.views ?? 0) / sourceTotal) * 100 : null;
  const momentum = useMemo(() => {
    if (!a || a.days.length < 8) return null;
    const half = Math.floor(a.days.length / 2);
    const prev = a.days.slice(0, half).reduce((n, d) => n + d.views, 0);
    const last = a.days.slice(half).reduce((n, d) => n + d.views, 0);
    if (!prev) return last ? 100 : null;
    return Math.max(-100, Math.min(100, ((last - prev) / prev) * 100));
  }, [a]);

  return (
    <div className="space-y-6">
      <section aria-label="Channel health" className="grid grid-cols-2 gap-y-6 rounded-xl border bg-card py-6 md:grid-cols-4 md:divide-x">
        <div className="flex justify-center px-2"><Gauge value={seo} label="Search score" hint={scored.length ? `Average of ${scored.length} videos' text` : "No videos yet"} /></div>
        <div className="flex justify-center px-2"><Gauge value={a?.avgViewPct ?? null} label="Watched" display={a?.avgViewPct !== undefined ? `${Math.round(a.avgViewPct)}%` : undefined} hint="Of each video, on average" /></div>
        <div className="flex justify-center px-2"><Gauge value={search} label="From search" display={search !== null ? `${Math.round(search)}%` : undefined} hint="Views that came from YouTube search" /></div>
        <div className="flex justify-center px-2"><Gauge
          value={momentum}
          min={-100}
          max={100}
          mode="bipolar"
          label="Momentum"
          display={momentum !== null ? `${momentum >= 0 ? "+" : ""}${Math.round(momentum)}%` : undefined}
          hint="Last two weeks vs the two before"
         
        /></div>
      </section>

      {a ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <section className="rounded-xl border bg-card p-4">
            <ViewsChart days={a.days} />
          </section>
          <section className="space-y-3 rounded-xl border bg-card p-4">
            <h2 className="font-semibold">Where viewers come from</h2>
            {a.sources.length ? (
              <ul className="space-y-2.5">
                {a.sources.slice(0, 7).map((x) => {
                  const pct = sourceTotal ? (x.views / sourceTotal) * 100 : 0;
                  return (
                    <li key={x.source} className="space-y-1">
                      <div className="flex justify-between gap-2 text-sm">
                        <span className={x.source === "YT_SEARCH" ? "font-medium" : undefined}>{sourceName(x.source)}</span>
                        <span className="tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--gauge-track)]">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: x.source === "YT_SEARCH" ? "var(--primary)" : "oklch(0.24 0.03 45 / 35%)" }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No views recorded yet.</p>
            )}
          </section>
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Searches that found you</h2>
          {a?.searches.length ? <p className="text-xs text-muted-foreground">Pick one to research it</p> : null}
        </div>
        {!a ? (
          <p className="text-sm text-muted-foreground">Reconnect YouTube to see the exact searches that bring viewers to your videos.</p>
        ) : a.searches.length ? (
          <div className="flex flex-wrap gap-2">
            {a.searches.map((x) => (
              <button
                key={x.term}
                type="button"
                onClick={() => onTopic(x.term)}
                className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm transition-colors hover:border-primary/60 hover:bg-accent/50"
              >
                <Search className="size-3.5 text-muted-foreground" />
                {x.term}
                <span className="tabular-nums text-xs text-muted-foreground">{num(x.views)}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-pretty text-muted-foreground">
            No views from YouTube search in the last 28 days yet. Shorts are mostly found in the feed at first; tuned titles and tags build search traffic over time.
          </p>
        )}
      </section>

      {s.channel.keywords.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Your channel keywords</h2>
          <div className="flex flex-wrap gap-1.5">
            {s.channel.keywords.map((k) => (
              <span key={k} className="rounded-md bg-secondary px-2 py-0.5 text-xs">
                {k}
              </span>
            ))}
          </div>
        </section>
      )}

      {s.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {s.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
