"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Clapperboard, Download, ExternalLink, FolderOpen, RefreshCw, Sparkles, Timer, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { YouTubeEmbed } from "@/components/youtube-embed";
import { StageProgress } from "@/components/stage-progress";
import { PickCard } from "@/components/pick-card";
import { AccessGate } from "@/components/access-gate";
import { api, useJob } from "@/hooks/use-job";
import { fmtTime, fmtRemaining, fmtDur } from "@/lib/utils";
import type { ClipState } from "@/lib/types";

export function VideoView({ id }: { id: string }) {
  const { job, error, setJob } = useJob(id);
  const [seek, setSeek] = useState<number | undefined>(undefined);
  const [revealErr, setRevealErr] = useState<string | null>(null);
  const [openingStudio, setOpeningStudio] = useState(false);

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
  async function openStudio() {
    if (openingStudio) return;
    setOpeningStudio(true);
    setRevealErr(null);
    try {
      const project = await api<{ id: string }>("/api/studio/projects", {
        method: "POST",
        body: JSON.stringify({
          name: `${job?.title ?? "Video"} edit`,
          sources: selected.map((clip) => ({ jobId: id, clipN: clip.n })),
        }),
      });
      window.location.href = `/studio/${project.id}`;
    } catch (error) {
      setRevealErr(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningStudio(false);
    }
  }
  async function renderSelected() {
    await api(`/api/jobs/${id}/render`, { method: "POST", body: JSON.stringify({}) });
  }
  async function cancel() {
    if (!confirm("Stop making clips? You can change the clip count and run it again.")) return;
    await api(`/api/jobs/${id}/cancel`, { method: "POST" });
  }
  async function repick() {
    if (!confirm("Ask AI for a fresh set of picks? Your current picks and edits will be replaced.")) return;
    await api(`/api/jobs/${id}/repick`, { method: "POST", body: JSON.stringify({}) });
  }
  /** Opens the job folder in Finder (macOS `open -R`, see app/api/jobs/[id]/reveal). */
  async function reveal() {
    setRevealErr(null);
    try {
      await api(`/api/jobs/${id}/reveal`, { method: "POST" });
    } catch (e) {
      setRevealErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="min-w-0 space-y-8">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Link href="/" className="flex min-h-10 items-center gap-1 hover:text-foreground md:min-h-0">
          <ArrowLeft className="size-4" /> Library
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <YouTubeEmbed videoId={job.videoId} seekTo={seek} />
          <div className="mt-4 min-w-0">
            <h1 className="text-balance break-words text-xl font-semibold tracking-tight sm:text-2xl">{job.title ?? "Fetching video…"}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {job.channel && <span className="truncate">{job.channel}</span>}
              {job.duration ? <span>{fmtTime(job.duration)}</span> : null}
              {job.wordCount ? <span>{job.wordCount.toLocaleString()} words · {job.transcriptSource === "whisper" ? "local Whisper" : "YouTube captions"}</span> : null}
              <a href={job.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                YouTube <ExternalLink className="size-3" />
              </a>
            </p>
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <StageProgress job={job} onCancel={busy ? cancel : undefined} />
          {job.status === "ready" && job.tookMs && (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
              <Timer className="size-3.5" /> Link to picks took <span className="font-mono text-foreground">{fmtDur(job.tookMs)}</span>
              {job.pickCostUsd ? <span> · AI ~${job.pickCostUsd.toFixed(2)} equiv.</span> : null}
            </p>
          )}
          {!busy && (
            <div className="space-y-2">
              {/* action bar: wraps freely; the folder path drops to its own line when there is no room */}
              <div className="flex flex-wrap items-center gap-2">
                {job.status === "error" && job.clips.length === 0 && (
                  <Button onClick={() => api(`/api/jobs/${id}/repick`, { method: "POST", body: "{}" })}>
                    <RefreshCw /> Try again
                  </Button>
                )}
                <AccessGate action="render">
                  <Button onClick={renderSelected} disabled={selected.length === 0 || rendering.length > 0}>
                    <Wand2 /> Render {selected.length} selected
                  </Button>
                </AccessGate>
                <Button variant="outline" onClick={openStudio} disabled={!selected.length || openingStudio}>
                  {openingStudio ? "Opening Studio…" : "Open selected in Studio"}
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
                <Button variant="outline" onClick={reveal} title="Reveal this video's folder in Finder">
                  <FolderOpen /> Show in Finder
                </Button>
                <span className="ml-auto min-w-0 max-w-full truncate font-mono text-xs text-muted-foreground max-sm:basis-full" title={job.dir}>
                  output/{job.dir}
                </span>
              </div>
              {revealErr && <p className="break-words text-xs text-red-400">{revealErr}</p>}
            </div>
          )}
          {rendering.length > 0 && (
            <div className="min-w-0 rounded-xl border bg-card p-4 text-sm">
              <p className="font-medium">
                Rendering {rendering.length} clip{rendering.length > 1 ? "s" : ""} · {fmtRemaining(renderEta)} left
              </p>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {rendering.map((c) => (
                  <li key={c.n} className="flex justify-between gap-3 font-mono text-xs">
                    <span className="min-w-0 truncate">
                      {String(c.n).padStart(2, "0")} {c.title}
                    </span>
                    <span className="shrink-0">{c.render.status === "rendering" ? `${Math.round((c.render.progress ?? 0) * 100)}%` : "queued"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {job.status === "ready" && job.log.length > 0 && (
            <details className="min-w-0 rounded-xl border bg-card p-4 text-xs">
              <summary className="cursor-pointer text-muted-foreground max-md:py-2">Log</summary>
              <ul className="mt-2 max-h-48 space-y-1 overflow-auto font-mono text-muted-foreground">
                {job.log.slice(-40).map((l, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words">
                    <span className="text-foreground/40">{job.startedAt ? `+${fmtDur(Math.max(0, l.t - job.startedAt)).padStart(6)}` : ""}</span>{" "}
                    <span className="text-foreground/60">{l.stage.padEnd(8)}</span> {l.msg}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {/* @container: the picks grid picks its column count from its own width (1 → 5 columns) */}
      <section className="@container min-w-0">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Sparkles className="size-4 text-primary" /> Picks
            </h2>
            <p className="text-pretty text-sm text-muted-foreground">Click a clip to edit and preview it. Tick the ones you want, then render.</p>
          </div>
          {job.clips.length > 0 && (
            <Badge variant="secondary" className="shrink-0">
              {selected.length}/{job.clips.length} selected
            </Badge>
          )}
        </div>

        {job.clips.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed px-4 py-16 text-center text-muted-foreground">
            <Clapperboard className="mb-2 size-8 opacity-50" />
            {busy ? "Picks will appear here as soon as AI is done." : "No picks yet."}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-4 @7xl:grid-cols-5 sm:gap-6">
            {job.clips.map((c) => (
              <div key={c.n} className="min-w-0 @max-sm:mx-auto @max-sm:w-full @max-sm:max-w-[300px]" onMouseEnter={() => setSeek(undefined)}>
                <PickCard jobId={job.id} clip={c} onSelect={(v) => toggle(c, v)} />
                <button className="mt-1 w-full truncate py-2 text-left text-xs text-muted-foreground hover:text-foreground max-md:min-h-10" onClick={() => setSeek(c.start)} title="Jump the YouTube player to this moment">
                  ▶ watch at {fmtTime(c.start)}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {job.status === "ready" && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
      <p className="mt-1 break-words text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
