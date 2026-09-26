"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlignLeft, ArrowLeft, ChevronLeft, ChevronRight, Download, ExternalLink, Loader2, Pause, Pencil, Play, Save, Sparkles, Trash2, Wand2, MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { YouTubeEmbed } from "@/components/youtube-embed";
import { CaptionOverlay } from "@/components/caption-overlay";
import { Timeline } from "@/components/timeline";
import { Transcript } from "@/components/transcript";
import { RenderStatus } from "@/components/pick-card";
import { PostTime } from "@/components/post-time";
import { PostTextCard } from "@/components/post-sheet";
import { ThumbnailCard } from "@/components/thumbnail-card";
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
  const [view, setView] = useState<"preview" | "youtube">("preview");
  const [t, setT] = useState(0); // absolute seconds
  const [playing, setPlaying] = useState(false);
  // a rendered clip is read-only until the user asks to re-render it
  const [unlocked, setUnlocked] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // load the draft from the server once (don't clobber edits on every SSE tick)
  useEffect(() => {
    if (clip && !draft) {
      setDraft({ start: clip.start, end: clip.end, title: clip.title, hook: clip.hook, reason: clip.reason, score: clip.score });
      setT(clip.start);
    }
  }, [clip, draft]);

  const seg = clip?.segment;
  const segReady = seg?.status === "done";
  const rendered = !!clip && clip.render.status === "done" && !!clip.render.url;
  const locked = rendered && !unlocked;
  const youtube = view === "youtube";
  // the locked view plays the rendered mp4, which starts at the clip's in point; the editor plays the padded segment
  const showRendered = rendered && locked;
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
    // locking/unlocking swaps the <video> src; re-seek to the clip start
    const v = videoRef.current;
    if (!v || !draft || !seg) return;
    v.pause();
    setPlaying(false);
    v.currentTime = showRendered ? 0 : draft.start - seg.start;
    setT(showRendered ? clip!.start : draft.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRendered]);

  // keyboard: space play/pause, arrows nudge playhead
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") seek(t - (e.shiftKey ? 1 : 0.1));
      else if (e.key === "ArrowRight") seek(t + (e.shiftKey ? 1 : 0.1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function edit(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setDirty(true);
  }
  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await api<ClipState>(`/api/jobs/${id}/clips/${n}`, { method: "PATCH", body: JSON.stringify(draft) });
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
    if (!confirm("Request a re-render? The range, title and hook unlock for editing; the current video and its files stay until the new render finishes.")) return;
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
    setView("preview");
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

  const topBar = (
    <div className="flex flex-wrap items-center gap-3">
      <Link href={`/v/${id}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {job.title}
      </Link>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" disabled={!prev} onClick={() => prev && router.push(`/v/${id}/clip/${prev.n}`)} aria-label="Previous clip">
          <ChevronLeft />
        </Button>
        <span className="font-mono text-xs text-muted-foreground">
          clip {idx + 1} / {job.clips.length}
        </span>
        <Button variant="ghost" size="icon-sm" disabled={!next} onClick={() => next && router.push(`/v/${id}/clip/${next.n}`)} aria-label="Next clip">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );

  // shared by both views: the phone-shaped player (rendered mp4, or the padded segment with live captions)
  const phone = (
    <div className="mx-auto w-full max-w-[340px] md:w-[300px]">
      <div className="relative overflow-hidden rounded-[28px] border-4 border-neutral-800 bg-black shadow-2xl [container-type:inline-size]" style={{ aspectRatio: "9/16" }}>
        {showRendered ? (
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
              <span className="px-4 text-red-600">Download failed: {seg.error}</span>
            ) : (
              <span>
                <Loader2 className="mx-auto mb-2 size-5 animate-spin" />
                fetching footage…
              </span>
            )}
          </div>
        )}
        <button onClick={togglePlay} className="absolute inset-0 grid place-items-center opacity-0 transition-opacity hover:opacity-100 focus:opacity-100" aria-label={playing ? "Pause" : "Play"}>
          <span className="rounded-full bg-black/60 p-4 text-white backdrop-blur">{playing ? <Pause className="size-7" /> : <Play className="size-7 fill-current" />}</span>
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-xs text-muted-foreground">
        <span>{fmtTimeMs(Math.max(0, t - draft.start))}</span>
        <span>{fmtTimeMs(len)}</span>
      </div>
    </div>
  );

  const transcriptCard = (
    <div className="min-h-[300px] min-w-0 rounded-xl border bg-card p-4 md:h-[533px]">
    <div className="flex h-full flex-col gap-3">
        <div className="flex h-8 items-center justify-between gap-2">
          <span className="text-sm font-medium">Transcript</span>
          <span className="font-mono text-xs text-muted-foreground">playhead {fmtTimeMs(t)}</span>
        </div>
        <div className="min-h-0 flex-1">
          <Transcript words={shownWords} start={draft.start} end={draft.end} playhead={t} onSeek={seek} />
        </div>
      </div>
    </div>
  );

  // rendered + locked: the posting sheet. Phone (+ transcript) on the left; upload text + render on one side, thumbnail + best time on the other.
  if (locked) {
    const ytUrl = `https://www.youtube.com/watch?v=${job.videoId}&t=${Math.floor(clip.start)}s`;
    const renderCard = (
      <div className="space-y-3 rounded-xl border bg-card p-5">
        <h2 className="font-semibold">Render</h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">
            {fmtTime(clip.start)} → {fmtTime(clip.end)} · {Math.round(len)}s
          </span>
          <Badge variant="secondary" title="Projected virality score">
            Projected virality score {clip.score}/10
          </Badge>
          <RenderStatus clip={clip} />
        </div>
        <Button className="w-full" asChild>
          <a href={r.url} download>
            <Download /> Download MP4
          </a>
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={requestRerender} title="Unlock the range, title and hook, then render again">
            <Pencil /> Request re-render
          </Button>
          <Button variant="ghost" size="icon" className="text-red-500 hover:text-red-600" onClick={remove} aria-label="Delete clip">
            <Trash2 />
          </Button>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => setShowTranscript((v) => !v)}>
            <AlignLeft className="size-3.5" /> {showTranscript ? "Hide transcript" : "Transcript"}
          </button>
          <a href={ytUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-foreground">
            <ExternalLink className="size-3.5" /> Source on YouTube
          </a>
        </div>
      </div>
    );
    return (
      <div className="space-y-5">
        {topBar}
        <div className="mx-auto grid max-w-[1200px] gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            {phone}
            {showTranscript && (
              <div className="h-72 rounded-xl border bg-card p-3">
                <Transcript words={shownWords} start={clip.start} end={clip.end} playhead={t} onSeek={seek} />
              </div>
            )}
          </div>
          <div className="grid items-start gap-4 md:grid-cols-2">
            {/* column 1: upload text + render */}
            <div className="min-w-0 space-y-4">
              <PostTextCard jobId={id} clip={clip} />
              {renderCard}
            </div>
            {/* column 2: thumbnail + best time */}
            <div className="min-w-0 space-y-4">
              <ThumbnailCard jobId={id} clip={clip} />
              <PostTime />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {topBar}

      {/* player+transcript · details+render. Upload text, thumbnail and best time live on the rendered view. The YouTube tab shows the embed alone. */}
      <div className={"grid gap-6 " + (youtube ? "" : "lg:grid-cols-[minmax(0,1fr)_380px]")}>
        {/* left column must be allowed to shrink: min-w-0 */}
        {/* left: player + timeline + transcript */}
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
              <TabsList>
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="youtube">
                  <MonitorPlay className="mr-1 size-3.5" /> YouTube
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <RenderStatus clip={clip} />
            </div>
          </div>

          {youtube ? (
            /* YouTube tab: nothing but the embed */
            <div className="mx-auto w-full max-w-5xl rounded-xl border bg-card p-4">
              <YouTubeEmbed videoId={job.videoId} seekTo={draft.start} className="w-full" />
            </div>
          ) : (
          <div className="grid gap-4 md:grid-cols-[300px_minmax(0,1fr)]">
            {phone}

            {transcriptCard}
          </div>
          )}

          {seg && !youtube && (
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
          {outsideSeg && !youtube && <p className="text-xs text-amber-700">This range goes past the downloaded footage. Saving will fetch a new segment.</p>}
          {!youtube && (
            <p className="text-xs text-muted-foreground">
              <kbd className="rounded border px-1">space</kbd> play · <kbd className="rounded border px-1">←</kbd> <kbd className="rounded border px-1">→</kbd> nudge 0.1s (shift: 1s) · drag the yellow handles to trim
            </p>
          )}
        </div>

        {/* middle: clip fields + render */}
        {!youtube && (
        <div className="space-y-4">
          <div className="space-y-4 rounded-xl border bg-card p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Clip details</h2>
              <Badge variant="secondary" title="Projected virality score">
                Projected virality score {draft.score}/10
              </Badge>
            </div>
            <Field label="Title">
              <Input value={draft.title} onChange={(e) => edit({ title: e.target.value })} />
            </Field>
            <Field label="Hook (shown for the first 3s)">
              <Input value={draft.hook} onChange={(e) => edit({ hook: e.target.value })} maxLength={60} placeholder="Leave empty for no hook" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="In">
                <Input type="number" step={0.1} min={seg?.start ?? 0} value={draft.start.toFixed(1)} onChange={(e) => edit({ start: Number(e.target.value) })} />
              </Field>
              <Field label="Out">
                <Input type="number" step={0.1} max={seg?.end} value={draft.end.toFixed(1)} onChange={(e) => edit({ end: Number(e.target.value) })} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              {fmtTime(draft.start)} → {fmtTime(draft.end)} · {Math.round(len)}s
            </p>
            <Field label="Why AI picked it">
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm leading-relaxed text-muted-foreground">{draft.reason}</p>
            </Field>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button onClick={() => save()} disabled={!dirty || saving} variant={dirty ? "default" : "outline"}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />} Save
              </Button>
              <Button className="flex-1 px-5" onClick={rewrite} disabled={rewriting} title="Ask AI for a title and hook that match why it picked this clip">
                {rewriting ? <Loader2 className="animate-spin" /> : <Sparkles />} Rewrite title & hook
              </Button>
            </div>
          </div>

          <div className="space-y-3 rounded-xl border bg-card p-5">
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
            {r.status === "error" && <p className="text-xs text-red-600">{r.error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={render} disabled={!segReady || r.status === "rendering" || r.status === "queued"}>
                <Wand2 /> {rendered ? "Re-render" : "Render this clip"}
              </Button>
              {rendered && (
                <Button variant="ghost" onClick={cancelEdit} title="Discard edits and go back to the rendered clip">
                  Cancel
                </Button>
              )}
              {rendered && (
                <Button variant="outline" asChild>
                  <a href={r.url} download>
                    <Download /> Download
                  </a>
                </Button>
              )}
              <Button variant="ghost" size="icon" className="ml-auto text-red-500 hover:text-red-600" onClick={remove} aria-label="Delete clip">
                <Trash2 />
              </Button>
            </div>
          </div>
        </div>
        )}
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
