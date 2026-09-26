"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Clapperboard, Download, ExternalLink, FolderOpen, RefreshCw, Sparkles, Timer, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { YouTubeEmbed } from "@/components/youtube-embed";
import { StageProgress } from "@/components/stage-progress";
import { PickCard } from "@/components/pick-card";
import { api, useJob } from "@/hooks/use-job";
import { fmtTime, fmtRemaining, fmtDur } from "@/lib/utils";
import type { ClipState } from "@/lib/types";

export function VideoView({ id }: { id: string }) {
  const { job, error, setJob } = useJob(id);
  const [seek, setSeek] = useState<number | undefined>(undefined);

  const selected = useMemo(() => job?.clips.filter((c) => c.selected) ?? [], [job]);
  const rendering = job?.clips.filter((c) => c.render.status === "rendering" || c.render.status === "queued") ?? [];
  const renderedCount = job?.clips.filter((c) => c.render.status === "done").length ?? 0;
  const selectedRendered = selected.filter((c) => c.render.status === "done");
  const renderEta = rendering.reduce((n, c) => n + (c.render.remaining ?? (c.end - c.start) * 0.3), 0);

  if (error) return <Empty title="Couldn't load this video" body={error} />;
  if (!job) return <Empty title="Loading…" body="" />;

  const busy = job.status === "analyzing" || job.status === "preparing";

  async function toggle(c: ClipState, v: boolean) {
    setJob({ ...job!, clips: job!.clips.map((x) => (x.n === c.n ? { ...x, selected: v } : x)) });
    await api(`/api/jobs/${id}/clips/${c.n}`, { method: "PATCH", body: JSON.stringify({ selected: v }) });
  }
  async function renderSelected() {
    await api(`/api/jobs/${id}/render`, { method: "POST", body: JSON.stringify({}) });
  }
  async function repick() {
    if (!confirm("Ask AI for a fresh set of picks? Your current picks and edits will be replaced.")) return;
    await api(`/api/jobs/${id}/repick`, { method: "POST", body: JSON.stringify({}) });
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Link href="/" className="flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-4" /> Library
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <YouTubeEmbed videoId={job.videoId} seekTo={seek} />
          <div className="mt-4">
            <h1 className="text-balance text-2xl font-semibold tracking-tight">{job.title ?? "Fetching video…"}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {job.channel && <span>{job.channel}</span>}
              {job.duration ? <span>{fmtTime(job.duration)}</span> : null}
              {job.wordCount ? <span>{job.wordCount.toLocaleString()} words · {job.transcriptSource === "whisper" ? "local Whisper" : "YouTube captions"}</span> : null}
              <a href={job.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                YouTube <ExternalLink className="size-3" />
              </a>
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <StageProgress job={job} />
          {job.status === "ready" && job.tookMs && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Timer className="size-3.5" /> Link to picks took <span className="font-mono text-foreground">{fmtDur(job.tookMs)}</span>
              {job.pickCostUsd ? <span> · AI ~${job.pickCostUsd.toFixed(2)} equiv.</span> : null}
            </p>
          )}
          {!busy && (
            <div className="flex flex-wrap items-center gap-2">
              {job.status === "error" && job.clips.length === 0 && (
                <Button onClick={() => api(`/api/jobs/${id}/repick`, { method: "POST", body: "{}" })}>
                  <RefreshCw /> Try again
                </Button>
              )}
              <Button onClick={renderSelected} disabled={selected.length === 0 || rendering.length > 0}>
                <Wand2 /> Render {selected.length} selected
              </Button>
              <Button variant="outline" onClick={repick}>
                <RefreshCw /> Ask AI again
              </Button>
              {renderedCount > 0 && (
                <Button variant="outline" asChild>
                  <a href={`/api/jobs/${id}/download${selectedRendered.length && selectedRendered.length < renderedCount ? `?ns=${selectedRendered.map((c) => c.n).join(",")}` : ""}`}>
                    <Download /> Download {selectedRendered.length && selectedRendered.length < renderedCount ? `${selectedRendered.length} selected` : `all ${renderedCount}`} as zip
                  </a>
                </Button>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                output/{job.dir}
              </span>
            </div>
          )}
          {rendering.length > 0 && (
            <div className="rounded-xl border bg-card p-4 text-sm">
              <p className="font-medium">
                Rendering {rendering.length} clip{rendering.length > 1 ? "s" : ""} · {fmtRemaining(renderEta)} left
              </p>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {rendering.map((c) => (
                  <li key={c.n} className="flex justify-between font-mono text-xs">
                    <span className="truncate">
                      {String(c.n).padStart(2, "0")} {c.title}
                    </span>
                    <span>{c.render.status === "rendering" ? `${Math.round((c.render.progress ?? 0) * 100)}%` : "queued"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {job.status === "ready" && job.log.length > 0 && (
            <details className="rounded-xl border bg-card p-4 text-xs">
              <summary className="cursor-pointer text-muted-foreground">Log</summary>
              <ul className="mt-2 max-h-48 space-y-1 overflow-auto font-mono text-muted-foreground">
                {job.log.slice(-40).map((l, i) => (
                  <li key={i}>
                    <span className="text-foreground/40">{job.startedAt ? `+${fmtDur(Math.max(0, l.t - job.startedAt)).padStart(6)}` : ""}</span>{" "}
                    <span className="text-foreground/60">{l.stage.padEnd(8)}</span> {l.msg}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      <section>
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Sparkles className="size-4 text-primary" /> Picks
            </h2>
            <p className="text-sm text-muted-foreground">Click a clip to edit and preview it. Tick the ones you want, then render.</p>
          </div>
          {job.clips.length > 0 && (
            <Badge variant="secondary">
              {selected.length}/{job.clips.length} selected
            </Badge>
          )}
        </div>

        {job.clips.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed py-16 text-muted-foreground">
            <Clapperboard className="mb-2 size-8 opacity-50" />
            {busy ? "Picks will appear here as soon as AI is done." : "No picks yet."}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
            {job.clips.map((c) => (
              <div key={c.n} onMouseEnter={() => setSeek(undefined)}>
                <PickCard jobId={job.id} clip={c} onSelect={(v) => toggle(c, v)} />
                <button className="mt-2 w-full truncate text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => setSeek(c.start)} title="Jump the YouTube player to this moment">
                  ▶ watch at {fmtTime(c.start)}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {job.status === "ready" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <FolderOpen className="size-3.5" /> Rendered files are saved next to this video's folder under <code className="rounded bg-muted px-1">output/</code>.
        </p>
      )}
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid place-items-center py-24 text-center">
      <p className="text-lg font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
