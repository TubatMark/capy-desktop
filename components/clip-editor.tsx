"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Loader2, Lock, Pause, Play, RotateCcw, Save, SkipBack, SkipForward, Sparkles, Trash2, Wand2, MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { YouTubeEmbed } from "@/components/youtube-embed";
import { CaptionOverlay } from "@/components/caption-overlay";
import { Timeline } from "@/components/timeline";
import { Transcript } from "@/components/transcript";
import { RenderStatus } from "@/components/pick-card";
import { PublishPanel } from "@/components/publish-panel";
import { PostTime } from "@/components/post-time";
import { api, useJob, useWords } from "@/hooks/use-job";
import { fmtTime, fmtTimeMs, fmtRemaining } from "@/lib/utils";
import type { ClipState } from "@/lib/types";

type Draft = Pick<ClipState, "start" | "end" | "title" | "hook" | "reason" | "score">;

export function ClipEditor({ id, n }: { id: string; n: number }) {
  const router = useRouter();
  const { job } = useJob(id);
  const words = useWords(id, !!job && !!job.wordCount);
  const clip = job?.clips.find((c) => c.n === n);
  const idx = job?.clips.findIndex((c) => c.n === n) ?? -1;
  const prev = idx > 0 ? job!.clips[idx - 1] : undefined;
  const next = idx >= 0 && idx < (job?.clips.length ?? 0) - 1 ? job!.clips[idx + 1] : undefined;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"preview" | "rendered" | "youtube">("preview");
  const [t, setT] = useState(0); // absolute seconds
  const [playing, setPlaying] = useState(false);
  // a rendered clip is read-only until the user asks to re-render it
  const [unlocked, setUnlocked] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // load the draft from the server once (don't clobber edits on every SSE tick)
  useEffect(() => {
    if (clip && !draft) {
      setDraft({ start: clip.start, end: clip.end, title: clip.title, hook: clip.hook, reason: clip.reason, score: clip.score });
      setT(clip.start);
      if (clip.render.status === "done") setView("rendered");
    }
  }, [clip, draft]);

  const seg = clip?.segment;
  const segReady = seg?.status === "done";
  const rendered = !!clip && clip.render.status === "done" && !!clip.render.url;
  const locked = rendered && !unlocked;
  // the rendered mp4 starts at the clip's in point; the preview plays the padded segment
  const showRendered = view === "rendered" && rendered;
  const base = showRendered ? clip!.start : seg?.start;
  const segWords = useMemo(() => (words && seg ? words.filter((w) => w.end > seg.start && w.start < seg.end) : []), [words, seg]);
  const clipWords = useMemo(
    () => (draft ? segWords.filter((w) => w.start >= draft.start - 0.1 && w.start < draft.end).map((w) => ({ ...w, start: w.start - draft.start, end: w.end - draft.start })) : []),
    [segWords, draft],
  );

  // transcript shown next to the player: the whole padded segment while editing, only the clip once it's rendered
  const shownWords = useMemo(() => (locked && clip ? segWords.filter((w) => w.start >= clip.start - 0.1 && w.start < clip.end) : segWords), [locked, clip, segWords]);

  // keep <video> in sync with the playhead
  const seek = useCallback(
    (abs: number) => {
      setT(abs);
      const v = videoRef.current;
      if (v && base !== undefined) v.currentTime = Math.max(0, abs - base);
    },
    [base],
  );
  function onTime() {
    const v = videoRef.current;
    if (!v || base === undefined || !draft) return;
    const abs = base + v.currentTime;
    setT(abs);
    if (!showRendered && abs >= draft.end) {
      v.pause();
      setPlaying(false);
    }
  }
  function togglePlay() {
    const v = videoRef.current;
    if (!v || !draft || !seg) return;
    if (v.paused) {
      if (showRendered) {
        if (v.ended) v.currentTime = 0;
      } else if (t < draft.start || t >= draft.end - 0.05) v.currentTime = draft.start - seg.start;
      void v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }
  useEffect(() => {
    // switching views swaps the <video> src; re-seek to the clip start
    const v = videoRef.current;
    if (!v || !draft || !seg) return;
    v.pause();
    setPlaying(false);
    v.currentTime = showRendered ? 0 : draft.start - seg.start;
    setT(showRendered ? clip!.start : draft.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRendered]);
  // the rendered tab goes away when the render is outdated or redone; fall back to the preview
  useEffect(() => {
    if (view === "rendered" && clip && !rendered) setView("preview");
  }, [view, clip, rendered]);

  function setIn() {
    if (!draft || locked) return;
    edit({ start: Math.min(t, draft.end - 3) });
  }
  function setOut() {
    if (!draft || locked) return;
    edit({ end: Math.max(t, draft.start + 3) });
  }
  // keyboard: space play/pause, I/O set in/out, arrows nudge playhead
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "i" || e.key === "I") setIn();
      else if (e.key === "o" || e.key === "O") setOut();
      else if (e.key === "ArrowLeft") seek(t - (e.shiftKey ? 1 : 0.1));
      else if (e.key === "ArrowRight") seek(t + (e.shiftKey ? 1 : 0.1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function edit(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setDirty(true);
  }
  async function save(snap = false) {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await api<ClipState>(`/api/jobs/${id}/clips/${n}`, { method: "PATCH", body: JSON.stringify({ ...draft, snap }) });
      setDraft({ start: updated.start, end: updated.end, title: updated.title, hook: updated.hook, reason: updated.reason, score: updated.score });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }
  async function render() {
    if (dirty) await save();
    await api(`/api/jobs/${id}/clips/${n}`, { method: "POST" });
    setUnlocked(false);
    setView("preview");
  }
  function requestRerender() {
    if (!confirm("Re-render this clip? You can edit the range, title and hook, then render it again. The current video stays until the new one is done.")) return;
    setUnlocked(true);
    setView("preview");
  }
  async function rewrite() {
    setRewriting(true);
    try {
      edit(await api<Pick<Draft, "title" | "hook">>(`/api/jobs/${id}/clips/${n}/rewrite`, { method: "POST" }));
    } finally {
      setRewriting(false);
    }
  }
  function cancelEdit() {
    reset();
    setUnlocked(false);
    setView("rendered");
  }
  async function remove() {
    if (!confirm("Delete this clip?")) return;
    await api(`/api/jobs/${id}/clips/${n}`, { method: "DELETE" });
    router.push(`/v/${id}`);
  }
  function reset() {
    if (!clip) return;
    setDraft({ start: clip.start, end: clip.end, title: clip.title, hook: clip.hook, reason: clip.reason, score: clip.score });
    setDirty(false);
  }

  if (!job || !clip || !draft) return <p className="py-24 text-center text-muted-foreground">Loading…</p>;
  const len = draft.end - draft.start;
  const r = clip.render;
  const outsideSeg = seg ? draft.start < seg.start - 0.01 || draft.end > seg.end + 0.01 : false;

  return (
    <div className="min-w-0 space-y-5">
      {/* top bar */}
      <div className="flex items-center gap-3">
        <Link href={`/v/${id}`} className="flex min-w-0 flex-1 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4 shrink-0" /> <span className="truncate">{job.title}</span>
        </Link>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <Button variant="ghost" size="icon-sm" disabled={!prev} onClick={() => prev && router.push(`/v/${id}/clip/${prev.n}`)} aria-label="Previous clip">
            <ChevronLeft />
          </Button>
          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
            clip {idx + 1} / {job.clips.length}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={!next} onClick={() => next && router.push(`/v/${id}/clip/${next.n}`)} aria-label="Next clip">
            <ChevronRight />
          </Button>
        </div>
      </div>

      {/*
        One grid, four blocks placed explicitly (DOM order = the single-column order):
          < lg   one column: preview → transcript → timeline → panels
          lg     two columns: preview + timeline | transcript + panels
          2xl    three columns: preview + timeline | transcript | panels
        The transcript block gets its height from the row (preview) on lg via an absolutely
        positioned inner box, and sticks to the viewport on 2xl.
      */}
      <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(0,3fr)]">
        {/* 1. preview: view tabs + phone frame + time readout */}
        <section className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={view} onValueChange={(v) => setView(v as typeof view)} className="min-w-0 max-w-full">
              <TabsList>
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="rendered" disabled={!rendered}>
                  Rendered {r.status === "stale" && "(outdated)"}
                </TabsTrigger>
                <TabsTrigger value="youtube">
                  <MonitorPlay className="mr-1 size-3.5" /> YouTube
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <RenderStatus clip={clip} />
            </div>
          </div>

          {/* phone frame: 9:16, never taller than 70vh (width follows), never wider than 340px */}
          <div className="mx-auto w-[min(100%,calc(70vh*9/16))] max-w-[340px]">
            <div className="relative max-h-[70vh] overflow-hidden rounded-[28px] border-4 border-neutral-800 bg-black shadow-2xl [container-type:inline-size]" style={{ aspectRatio: "9/16" }}>
              {view === "youtube" ? (
                <div className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-muted-foreground">Playing in the YouTube player</div>
              ) : showRendered ? (
                <video ref={videoRef} key={r.url} src={r.url} className="absolute inset-0 size-full object-contain" onTimeUpdate={onTime} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} playsInline />
              ) : segReady ? (
                <>
                  <video
                    ref={videoRef}
                    key={seg!.url}
                    src={seg!.url}
                    className={"absolute inset-0 size-full " + (job.settings.layout === "blur" ? "object-contain" : "object-cover")}
                    onTimeUpdate={onTime}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onLoadedMetadata={() => seek(draft.start)}
                    playsInline
                    preload="auto"
                  />
                  <CaptionOverlay words={clipWords} t={t - draft.start} style={job.settings.style} hook={draft.hook} showHook={job.settings.hook} />
                </>
              ) : (
                <div className="absolute inset-0 grid place-items-center text-center text-xs text-muted-foreground">
                  {seg?.status === "error" ? (
                    <span className="px-4 text-red-300">Download failed: {seg.error}</span>
                  ) : (
                    <span>
                      <Loader2 className="mx-auto mb-2 size-5 animate-spin" />
                      fetching footage…
                    </span>
                  )}
                </div>
              )}
              {view !== "youtube" && (
                <button onClick={togglePlay} className="absolute inset-0 grid place-items-center opacity-0 transition-opacity hover:opacity-100 focus:opacity-100" aria-label={playing ? "Pause" : "Play"}>
                  <span className="rounded-full bg-black/60 p-4 text-white backdrop-blur">{playing ? <Pause className="size-7" /> : <Play className="size-7 fill-current" />}</span>
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between font-mono text-xs text-muted-foreground">
              <span>{fmtTimeMs(Math.max(0, t - draft.start))}</span>
              <span>{fmtTimeMs(len)}</span>
            </div>
          </div>
        </section>

        {/* 2. transcript (or the YouTube player in that view) */}
        <section className="min-w-0 lg:relative lg:col-start-2 lg:row-start-1 2xl:row-span-2">
          <div className="flex h-80 flex-col gap-2 lg:absolute lg:inset-0 lg:h-auto 2xl:sticky 2xl:inset-auto 2xl:top-[4.5rem] 2xl:h-[min(calc(100vh-5.5rem),56rem)]">
            {view === "youtube" ? (
              <YouTubeEmbed videoId={job.videoId} seekTo={draft.start} className="w-full shrink-0" />
            ) : (
              <>
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                  {locked ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Lock className="size-3.5 shrink-0" /> Rendered transcript · click a word to jump there
                    </span>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={setIn} title="Set the clip's start at the playhead (I)">
                        <SkipBack /> Set In
                      </Button>
                      <Button size="sm" variant="outline" onClick={setOut} title="Set the clip's end at the playhead (O)">
                        Set Out <SkipForward />
                      </Button>
                    </>
                  )}
                  <span className="ml-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {locked ? fmtTimeMs(Math.max(0, t - clip.start)) : `playhead ${fmtTimeMs(t)}`}
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <Transcript words={shownWords} start={draft.start} end={draft.end} playhead={t} onSeek={seek} />
                </div>
              </>
            )}
          </div>
        </section>

        {/* 3. timeline + notes */}
        <section className="min-w-0 space-y-3 lg:col-start-1 lg:row-start-2">
          {seg && !locked && (
            <Timeline
              segStart={seg.start}
              segEnd={seg.end}
              start={draft.start}
              end={draft.end}
              playhead={t}
              words={segWords}
              onChange={(s, e, commit) => {
                edit({ start: s, end: e });
                if (commit) seek(s);
              }}
              onSeek={seek}
            />
          )}
          {outsideSeg && !locked && <p className="text-xs text-amber-300">This range goes past the downloaded footage. Saving will fetch a new segment.</p>}
          {!locked && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              <kbd className="rounded border px-1">space</kbd> play · <kbd className="rounded border px-1">I</kbd> / <kbd className="rounded border px-1">O</kbd> set in/out at playhead · <kbd className="rounded border px-1">←</kbd> <kbd className="rounded border px-1">→</kbd> nudge 0.1s (shift: 1s) · drag the yellow handles to trim
            </p>
          )}
        </section>

        {/* 4. panels: details, render, publish, post time */}
        <section className="min-w-0 space-y-4 lg:col-start-2 lg:row-start-2 2xl:col-start-3 2xl:row-span-2 2xl:row-start-1">
          <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-semibold">
                Clip details {locked && <Lock className="size-3.5 text-muted-foreground" aria-label="Locked: rendered" />}
              </h2>
              <Badge variant="secondary" className="shrink-0">{draft.score}/10</Badge>
            </div>
            <Field label="Title">
              <Input value={draft.title} onChange={(e) => edit({ title: e.target.value })} disabled={locked} />
            </Field>
            <Field label="Hook (shown for the first 3s)">
              <Input value={draft.hook} onChange={(e) => edit({ hook: e.target.value })} maxLength={60} placeholder="Leave empty for no hook" disabled={locked} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="In">
                <Input type="number" step={0.1} min={seg?.start ?? 0} value={draft.start.toFixed(1)} onChange={(e) => edit({ start: Number(e.target.value) })} disabled={locked} />
              </Field>
              <Field label="Out">
                <Input type="number" step={0.1} max={seg?.end} value={draft.end.toFixed(1)} onChange={(e) => edit({ end: Number(e.target.value) })} disabled={locked} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              {fmtTime(draft.start)} → {fmtTime(draft.end)} · {Math.round(len)}s
            </p>
            <Field label="Why AI picked it">
              <Textarea value={draft.reason} onChange={(e) => edit({ reason: e.target.value })} rows={3} className="text-muted-foreground" disabled={locked} />
            </Field>
            {locked ? (
              <p className="text-xs text-muted-foreground">This clip is rendered. Request a re-render below to edit it.</p>
            ) : (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={() => save(false)} disabled={!dirty || saving} variant={dirty ? "default" : "secondary"}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />} Save
              </Button>
              <Button variant="outline" onClick={() => save(true)} disabled={saving} title="Move in/out to the nearest sentence or pause">
                Snap to speech
              </Button>
              <Button variant="outline" onClick={rewrite} disabled={rewriting} title="Ask AI for a title and hook that match why it picked this clip">
                {rewriting ? <Loader2 className="animate-spin" /> : <Sparkles />} Rewrite title & hook
              </Button>
              <Button variant="ghost" size="icon" onClick={reset} disabled={!dirty} aria-label="Reset">
                <RotateCcw />
              </Button>
            </div>
            )}
          </div>

          <div className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
            <h2 className="font-semibold">Render</h2>
            <p className="text-sm text-muted-foreground">
              1080×1920 · {job.settings.layout === "blur" ? "blur bars" : "center crop"} · {job.settings.style} captions · est. {fmtRemaining(len * 0.3)}
            </p>
            {r.status === "rendering" && (
              <div className="space-y-1 text-sm">
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round((r.progress ?? 0) * 100)}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {Math.round((r.progress ?? 0) * 100)}% · {fmtRemaining(r.remaining ?? 0)} left
                </p>
              </div>
            )}
            {r.status === "error" && <p className="break-words text-xs text-red-300">{r.error}</p>}
            <div className="flex flex-wrap gap-2">
              {locked ? (
                <Button onClick={requestRerender} title="Unlock this clip to edit and render it again">
                  <Wand2 /> Request re-render
                </Button>
              ) : (
                <>
                  <Button onClick={render} disabled={!segReady || r.status === "rendering" || r.status === "queued"}>
                    <Wand2 /> {rendered ? "Re-render" : "Render this clip"}
                  </Button>
                  {rendered && (
                    <Button variant="ghost" onClick={cancelEdit}>
                      Cancel
                    </Button>
                  )}
                </>
              )}
              {rendered && (
                <Button variant="outline" asChild>
                  <a href={r.url} download>
                    <Download /> Download
                  </a>
                </Button>
              )}
              <Button variant="ghost" size="icon" className="ml-auto text-red-300 hover:text-red-200" onClick={remove} aria-label="Delete clip">
                <Trash2 />
              </Button>
            </div>
          </div>
          <PublishPanel jobId={id} clip={clip} />
          <PostTime />
        </section>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
