"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, CalendarClock, CheckCircle2, ExternalLink, Film, HardDrive, Loader2, Plus, RotateCcw, Trash2, Upload, Users, X } from "lucide-react";
import { QueueCalendar } from "@/components/queue/queue-calendar";
import { KIND, KindMark } from "@/components/queue/post-bits";
import { Button } from "@/components/ui/button";
import { ViewToggle, useBoardView } from "@/components/view-toggle";
import { dayKey, fmtDay, type DayPost } from "@/lib/queue-calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/hooks/use-job";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import {
  LONG_COLUMNS,
  longDayItems,
  RESULTS_TO_COMPARE,
  columnOf,
  easternTime,
  formatLength,
  philippineTime,
  type AudienceReport,
  type AutopilotSettings,
  type CreatorFootage,
  type LiveTime,
  type LongColumn,
  type LongVideo,
  type SlotResult,
  type UploadSlot,
} from "@/lib/longform";
import { cn } from "@/lib/utils";

interface Board {
  videos: LongVideo[];
  audience: AudienceReport | null;
  slots: UploadSlot[];
  recommended: { slot: UploadSlot; at: number } | null;
  results: SlotResult[];
  live: Record<string, LiveTime>;
  autopilot: AutopilotSettings;
}
interface CleanupPlan {
  allowed: boolean;
  blocked?: string;
  files: { path: string; bytes: number }[];
  kept: { path: string; why: string }[];
  bytes: number;
}

/** One colour per column, repeated on its cards. The column's name always goes with it, so colour is never the only cue. */
const TONE: Record<LongColumn, { top: string; dot: string; edge: string }> = {
  draft: { top: "border-t-slate-400", dot: "bg-slate-400", edge: "border-l-slate-400" },
  progress: { top: "border-t-blue-500", dot: "bg-blue-500", edge: "border-l-blue-500" },
  review: { top: "border-t-amber-500", dot: "bg-amber-500", edge: "border-l-amber-500" },
  uploading: { top: "border-t-violet-500", dot: "bg-violet-500", edge: "border-l-violet-500" },
  scheduled: { top: "border-t-cyan-600", dot: "bg-cyan-600", edge: "border-l-cyan-600" },
  public: { top: "border-t-emerald-600", dot: "bg-emerald-600", edge: "border-l-emerald-600" },
  freed: { top: "border-t-stone-400", dot: "bg-stone-400", edge: "border-l-stone-400" },
};
/** Go-live time: green is booked, amber a projection, orange needs the owner. */
const liveTone = (l: LiveTime) => (l.booked ? "bg-emerald-600/15 text-emerald-900" : l.needsOwner ? "bg-orange-500/15 text-orange-900" : "bg-amber-500/15 text-amber-900");

const media = (rel: string) => `/api/media/${rel.split("/").map(encodeURIComponent).join("/")}`;
const gb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
const minutes = (s: number) => `${Math.round(s / 60)} min`;
const COUNTRY: Record<string, string> = { US: "United States", PH: "Philippines", GB: "United Kingdom", IN: "India", DE: "Germany", CA: "Canada", AU: "Australia", NL: "Netherlands", ZA: "South Africa", ID: "Indonesia" };

/** Every long video on one board. The worker moves the cards; the owner acts through buttons, so nothing can skip a check. */
export function LongFormBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useBoardView("long-form");

  const load = useCallback(() => {
    return api<Board>("/api/longform")
      .then((b) => {
        setBoard(b);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useVisibleInterval(load, 4000);

  const open = board?.videos.find((v) => v.id === openId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Film className="size-6 text-primary" /> Long-form
          </h1>
          <p className="text-sm text-muted-foreground">Ranked videos made, reviewed, uploaded and published automatically. Open any video to step in.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewToggle view={mode} onChange={setMode} />
          <Button onClick={() => setPicking(true)} disabled={!board}>
            <Plus className="size-4" /> New video
          </Button>
        </div>
      </div>

      {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      {!board && !err && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading the board
        </p>
      )}

      {board && mode === "calendar" && <LongCalendar board={board} onOpen={setOpenId} />}

      {board && mode === "kanban" && (
        <div className="-mx-1 overflow-x-auto px-1 pb-2">
          <div className="grid min-w-[1260px] grid-cols-7 gap-3">
            {LONG_COLUMNS.map((col) => {
              const cards = board.videos.filter((v) => columnOf(v.status) === col.id);
              return (
                <section key={col.id} aria-label={col.label} className={cn("flex min-h-64 flex-col gap-2 rounded-xl border-t-4 bg-muted/50 p-2", TONE[col.id].top)}>
                  <header className="px-1 py-1">
                    <h2 className="flex items-center justify-between text-sm font-medium">
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden className={cn("size-2 rounded-full", TONE[col.id].dot)} /> {col.label}
                      </span>{" "}
                      <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
                    </h2>
                    <p className="text-xs text-muted-foreground">{col.hint}</p>
                  </header>
                  {cards.map((v) => (
                    <VideoCard key={v.id} video={v} live={board.live[v.id]} onOpen={() => setOpenId(v.id)} />
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        What capy does by itself is set in{" "}
        <Link href="/settings#automation" className="underline underline-offset-2">
          Settings
        </Link>
        .
      </p>

      {board && (
        <div className="grid gap-4 lg:grid-cols-2">
          <TimesPanel board={board} />
          <AudiencePanel audience={board.audience} />
        </div>
      )}

      {picking && <NewVideoDialog onClose={() => setPicking(false)} onCreated={load} />}
      {open && board && <VideoDialog video={open} live={board.live[open.id]} publishOn={board.autopilot.publish} board={board} onClose={() => setOpenId(null)} onChange={load} />}
    </div>
  );
}

function VideoCard({ video: v, live, onOpen }: { video: LongVideo; live?: LiveTime; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className={cn("w-full space-y-2 rounded-lg border border-l-4 bg-card p-2 text-left shadow-sm transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-primary", v.error ? "border-l-red-600" : TONE[columnOf(v.status)].edge)}>
      {v.thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media(v.thumb)} alt="" className="aspect-video w-full rounded object-cover" />
      ) : (
        <div className="grid aspect-video w-full place-items-center rounded bg-muted text-muted-foreground">
          <Film className="size-5" />
        </div>
      )}
      <p className="line-clamp-2 text-sm font-medium">{v.title}</p>
      <p className="text-xs text-muted-foreground">
        {v.creator} · {v.format === "tier" ? "Tier list" : v.format === "awards" ? "Awards" : "Countdown"} · {v.clips.length} moments{v.check?.duration ? ` · ${formatLength(v.check.duration)}` : ""}
      </p>
      {v.step && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> {v.step}
        </p>
      )}
      {v.progress !== undefined && (
        <div className="h-1 overflow-hidden rounded bg-muted">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(v.progress * 100)}%` }} />
        </div>
      )}
      {live && (
        <p className={cn("rounded px-1.5 py-1 text-xs font-medium", liveTone(live))}>
          {v.youtube?.publishedAt ? "Went live" : live.booked ? "Goes live" : "Planned live"}: {philippineTime(live.at)}
        </p>
      )}
      {v.status === "private" && <p className="text-xs text-muted-foreground">Private on YouTube</p>}
      {v.masterBytes && v.status !== "freed" ? <p className="text-xs text-muted-foreground">{gb(v.masterBytes)} master</p> : null}
      {v.freed && <p className="text-xs text-muted-foreground">Freed {gb(v.freed.bytes)}</p>}
      {v.error && (
        <p className="flex items-start gap-1 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" /> <span className="line-clamp-3">{v.error}</span>
        </p>
      )}
    </button>
  );
}

function Sheet({ open, title, onClose, wide, children }: { open: boolean; title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className={cn("fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl", wide ? "max-w-3xl" : "max-w-lg")}>
          <div className="mb-4 flex items-start justify-between gap-3">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-muted">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NewVideoDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [footage, setFootage] = useState<CreatorFootage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // walks every clip, so it's only worked out when this dialog opens
  useEffect(() => {
    void api<{ footage: CreatorFootage[] }>("/api/longform?footage=1")
      .then((r) => setFootage(r.footage))
      .catch((e) => {
        setFootage([]);
        setErr(e instanceof Error ? e.message : String(e));
      });
  }, []);
  async function create(creator: string) {
    setBusy(creator);
    setErr(null);
    try {
      await api("/api/longform", { method: "POST", body: JSON.stringify({ action: "create", creator }) });
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Sheet open title="New long video" onClose={onClose}>
      <p className="mb-3 text-sm text-muted-foreground">Footage that hasn't gone into a long video yet. A video needs at least 8 minutes.</p>
      <ul className="divide-y">
        {!footage && (
          <li className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Adding up the footage…
          </li>
        )}
        {footage?.map((f) => (
          <li key={f.creator} className="flex items-center justify-between gap-3 py-2">
            <div>
              <p className="text-sm font-medium">{f.creator}</p>
              <p className="text-xs text-muted-foreground">
                {f.clips} moments · about {minutes(f.estimateSeconds)} finished
              </p>
            </div>
            <Button size="sm" variant={f.enough ? "default" : "outline"} disabled={!f.enough || !!busy} onClick={() => create(f.creator)}>
              {busy === f.creator ? <Loader2 className="size-4 animate-spin" /> : f.enough ? "Make video" : "Not enough yet"}
            </Button>
          </li>
        ))}
        {footage && !footage.length && !err && <li className="py-3 text-sm text-muted-foreground">No unused footage yet.</li>}
      </ul>
      {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
    </Sheet>
  );
}

function VideoDialog({ video: v, live, publishOn, board, onClose, onChange }: { video: LongVideo; live?: LiveTime; publishOn: boolean; board: Board; onClose: () => void; onChange: () => void }) {
  const [title, setTitle] = useState(v.title);
  const [description, setDescription] = useState(v.description ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<CleanupPlan | null>(null);
  const [confirmFree, setConfirmFree] = useState(false);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [ownTime, setOwnTime] = useState("");

  const action = useCallback(
    async (name: string, body: Record<string, unknown>) => {
      setBusy(name);
      setErr(null);
      try {
        await api(`/api/longform/${v.id}`, { method: "POST", body: JSON.stringify(body) });
        onChange();
        return true;
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [v.id, onChange],
  );
  const editable = !v.youtube?.id && !v.youtube?.session;
  useEffect(() => {
    if (editable) return;
    void api<{ cleanup: CleanupPlan }>(`/api/longform/${v.id}`).then((r) => setCleanup(r.cleanup)).catch(() => {});
  }, [v.id, v.status, editable]);

  async function remove() {
    setBusy("delete");
    try {
      await api(`/api/longform/${v.id}`, { method: "DELETE" });
      onChange();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function saveAndUpload() {
    if ((title !== v.title || description !== (v.description ?? "")) && !(await action("text", { action: "text", title, description }))) return;
    await action("upload", { action: "upload" });
  }

  const rec = board.recommended;
  return (
    <Sheet open title={v.title} wide onClose={onClose}>
      <div className="space-y-4">
        {v.master && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={media(v.master)} poster={v.thumb ? media(v.thumb) : undefined} controls preload="metadata" className="aspect-video w-full rounded-lg bg-black" />
        )}

        {live && (
          <div className={cn("rounded-lg p-3 text-sm", liveTone(live))}>
            <p className="flex items-center gap-1.5 font-medium">
              <CalendarClock className="size-4" /> {v.youtube?.publishedAt ? "Went live" : live.booked ? "Goes live" : "Planned live"}: {philippineTime(live.at)}
            </p>
            <p className="text-xs">{easternTime(live.at)}</p>
            {!live.booked && (
              <p className="mt-1 text-xs">
                {live.needsOwner ? "Not booked yet. The checks found a file problem, so this one needs you to schedule it." : publishOn ? "Not booked yet. capy books it automatically, 6 hours or more after processing. You can pick a time yourself once it's on YouTube." : "Not booked yet. Turn on Go public in Settings, or schedule it yourself once it's on YouTube."}
              </p>
            )}
          </div>
        )}

        {v.error && (
          <div className="flex items-start justify-between gap-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            <span>{v.error}</span>
            {v.failedStep && (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => action("retry", { action: "retry" })}>
                <RotateCcw className="size-4" /> Retry
              </Button>
            )}
          </div>
        )}

        {v.check && (v.status === "review" || v.check.warnings.length > 0 || v.check.script?.notes.length) ? (
          <div className="space-y-1 rounded-lg border p-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium">
              {v.check.ok ? <CheckCircle2 className="size-4 text-primary" /> : <AlertTriangle className="size-4 text-amber-600" />}
              {v.check.ok ? "The automatic review found nothing" : "The automatic review left these notes"}
            </p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {v.check.warnings.map((w) => <li key={w}>{w}</li>)}
              {v.check.script?.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
            {v.voice && <p className="text-xs text-muted-foreground">Narrator: {v.voice}</p>}
          </div>
        ) : null}

        {editable && v.status === "review" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="lf-title">Title</Label>
              <Input id="lf-title" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lf-desc">Description</Label>
              <Textarea id="lf-desc" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {v.status === "review" && (
            <Button variant="outline" disabled={!!busy || !title.trim()} onClick={saveAndUpload}>
              {busy === "upload" ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Upload as Private now
            </Button>
          )}
          {v.status === "review" && !!v.check?.warnings?.length && (
            <Button variant="outline" disabled={!!busy} onClick={() => action("recheck", { action: "recheck" })}>
              <RotateCcw className="size-4" /> Run the checks again
            </Button>
          )}
          {editable && (["draft", "review"].includes(v.status) || v.error) && (
            <Button variant="outline" disabled={!!busy} onClick={remove}>
              <Trash2 className="size-4" /> Delete
            </Button>
          )}
          {v.youtube?.id && (
            <Button variant="outline" asChild>
              <a href={`https://studio.youtube.com/video/${v.youtube.id}/edit`} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" /> Open in YouTube Studio
              </a>
            </Button>
          )}
        </div>
        {v.youtube?.note && <p className="text-xs text-muted-foreground">{v.youtube.note}</p>}

        {v.status !== "public" && v.status !== "freed" && (
          <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={!v.manual} disabled={!!busy} onChange={(e) => action("manual", { action: "manual", on: !e.target.checked })} />
            <span>
              <span className="font-medium">Automatic</span>
              <span className="block text-xs text-muted-foreground">{v.manual ? "You're handling this video. capy won't upload, schedule or delete it. Tick to hand it back." : "capy uploads, schedules and cleans up this video. Untick to handle it yourself."}</span>
            </span>
          </label>
        )}

        {v.youtube?.processedAt && !v.youtube.publishedAt && (
          <div className="space-y-2 rounded-lg border p-3 text-sm">
            <h3 className="flex items-center gap-1.5 font-medium">
              <CalendarClock className="size-4" /> Going public
            </h3>
            {v.slotAt ? (
              <>
                <p>
                  Goes public {philippineTime(v.slotAt)} ({easternTime(v.slotAt)}).
                </p>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => action("unschedule", { action: "unschedule" })}>
                  Keep it Private
                </Button>
              </>
            ) : rec ? (
              <>
                <p>
                  Next open slot: {philippineTime(rec.at)} ({easternTime(rec.at)}).
                </p>
                <p className="text-muted-foreground">Or pick your own time. Doing either makes this video manual.</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input type="datetime-local" aria-label="Go-live time" className="w-auto" value={ownTime} onChange={(e) => setOwnTime(e.target.value)} />
                  <Button size="sm" variant="outline" disabled={!!busy || !ownTime} onClick={() => action("schedule", { action: "schedule", at: new Date(ownTime).getTime() })}>
                    Use this time
                  </Button>
                  {!v.manual && (
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => action("manual", { action: "manual", on: true })}>
                      Keep it Private
                    </Button>
                  )}
                </div>
                {confirmPublic ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={!!busy} onClick={() => action("schedule", { action: "schedule", at: rec.at, slotId: rec.slot.id }).then(() => setConfirmPublic(false))}>
                      Yes, make it public at that time
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmPublic(false)}>
                      Keep it Private
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setConfirmPublic(true)}>
                    Schedule for this slot
                  </Button>
                )}
              </>
            ) : null}
          </div>
        )}

        {v.metrics?.length ? (
          <div className="rounded-lg border p-3 text-sm">
            <h3 className="mb-1 font-medium">Results</h3>
            {v.metrics.map((m) => (
              <p key={m.ageHours} className="text-muted-foreground">
                After {m.ageHours === 48 ? "48 hours" : "a week"}: {m.views.toLocaleString("en-US")} views, {m.philippinesViews.toLocaleString("en-US")} from the Philippines
                {m.avgViewPct !== undefined ? `, ${Math.round(m.avgViewPct)}% watched` : ""}
              </p>
            ))}
          </div>
        ) : null}

        {cleanup && v.status !== "freed" && (
          <div className="space-y-2 rounded-lg border p-3 text-sm">
            <h3 className="flex items-center gap-1.5 font-medium">
              <HardDrive className="size-4" /> Free up space
            </h3>
            {cleanup.blocked ? <p className="text-muted-foreground">{cleanup.blocked}.</p> : <p>Permanently deletes {cleanup.files.length} local files ({gb(cleanup.bytes)}). The video on YouTube stays, and so do transcripts and finished Shorts.</p>}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                {cleanup.files.length} to delete, {cleanup.kept.length} kept
              </summary>
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto break-all">
                {cleanup.files.map((f) => <li key={f.path}>{f.path} ({gb(f.bytes)})</li>)}
                {cleanup.kept.map((f) => <li key={f.path}>Kept: {f.path}. {f.why}.</li>)}
              </ul>
            </details>
            {cleanup.allowed &&
              (confirmFree ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => action("free", { action: "free" }).then(() => setConfirmFree(false))}>
                    Yes, delete these files
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmFree(false)}>
                    Keep them
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirmFree(true)}>
                  Free {gb(cleanup.bytes)}
                </Button>
              ))}
          </div>
        )}

        {v.intro && (
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">Script and moments</summary>
            <div className="mt-2 space-y-2 text-muted-foreground">
              <p>{v.intro}</p>
              <ol className="space-y-2">
                {v.clips.map((c, i) => (
                  <li key={`${c.jobId}:${c.n}`}>
                    <span className="font-medium text-foreground">
                      #{v.clips.length - i} {c.title}
                    </span>
                    <br />
                    {c.line}
                  </li>
                ))}
              </ol>
              <p>{v.outro}</p>
            </div>
          </details>
        )}

        {v.titleOptions?.length || v.thumbOptions?.length ? (
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">Other titles and thumbnails to A/B test</summary>
            <p className="mt-2 text-xs text-muted-foreground">YouTube Studio can test up to three of each, and picks the winner by watch time. Use Test &amp; compare on the video&apos;s page there.</p>
            <ul className="mt-2 list-disc pl-5 text-muted-foreground">
              {v.titleOptions?.map((t) => <li key={t}>{t}</li>)}
            </ul>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {v.thumbOptions?.map((t) => (
                // eslint-disable-next-line @next/next/no-img-element
                <a key={t} href={media(t)} download><img src={media(t)} alt="Thumbnail option" className="aspect-video w-full rounded object-cover" /></a>
              ))}
            </div>
          </details>
        ) : null}

        {v.screenedOut?.length ? (
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">{v.screenedOut.length} moments left out by the content check</summary>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {v.screenedOut.map((s) => (
                <li key={s.title}>
                  <span className="text-foreground">{s.title}</span>: {s.why}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {err && <p className="text-sm text-destructive">{err}</p>}
      </div>
    </Sheet>
  );
}

const TZ = "Asia/Manila";
const clock = (at: number) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(at);

/** Long videos by day, in Philippine time: numbers on the month, the day's list on the right. */
function LongCalendar({ board, onOpen }: { board: Board; onOpen: (id: string) => void }) {
  const today = dayKey(Date.now(), TZ);
  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(today);
  const items = longDayItems(board.videos, board.live);
  const days = new Map<string, DayPost[]>();
  for (const it of items) {
    const key = dayKey(it.at, TZ);
    days.set(key, [...(days.get(key) ?? []), { group: it.id, entries: [], at: it.at, kind: it.kind }]);
  }
  const list = items.filter((it) => dayKey(it.at, TZ) === selected).sort((a, b) => a.at - b.at);
  return (
    <section className="@container" aria-label="Long-form calendar">
      <div className="grid items-start gap-5 @3xl:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
        <QueueCalendar days={days} view={month} selected={selected} today={today} tzLabel="Philippine" onView={setMonth} onSelect={setSelected} />
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <h2 className="font-semibold">{fmtDay(selected)}</h2>
          {!list.length && <p className="text-sm text-muted-foreground">Nothing posted or scheduled on this day.</p>}
          <ul className="space-y-2">
            {list.map((it) => {
              const v = board.videos.find((x) => x.id === it.id)!;
              return (
                <li key={it.id}>
                  <button type="button" onClick={() => onOpen(it.id)} className="flex w-full items-start gap-3 rounded-lg border p-2 text-left transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-primary">
                    {v.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={media(v.thumb)} alt="" className="aspect-video w-32 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="grid aspect-video w-32 shrink-0 place-items-center rounded bg-muted text-muted-foreground">
                        <Film className="size-5" />
                      </span>
                    )}
                    <span className="min-w-0 space-y-1 text-sm">
                      <span className="line-clamp-2 block font-medium">{v.title}</span>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <KindMark kind={it.kind} className="size-2" />
                        {it.kind === "scheduled" && !it.booked ? "Planned" : KIND[it.kind].label} · {clock(it.at)} PHT · {v.creator}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

function TimesPanel({ board }: { board: Board }) {
  const result = (id: string) => board.results.find((r) => r.slotId === id);
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="flex items-center gap-2 font-medium">
        <CalendarClock className="size-4" /> Upload times
      </h2>
      <p className="text-sm text-muted-foreground">A starting test, not a proven answer. capy rotates through these and compares views a week after publishing.</p>
      <ul className="divide-y text-sm">
        {board.slots.map((s) => {
          const r = result(s.id);
          const at = Date.UTC(2026, 10, 7 + ((s.day - 6 + 7) % 7), s.hour - 8, s.minute);
          return (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <p className="font-medium">{s.label}</p>
                <p className="text-xs text-muted-foreground">
                  {new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", weekday: "long", hour: "numeric", minute: "2-digit" }).format(at)} PHT · {new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).format(at)} ET
                </p>
              </div>
              <p className="text-xs text-muted-foreground">{r?.comparable ? `${r.avgViews.toLocaleString("en-US")} views avg, ${r.avgPhilippinesViews.toLocaleString("en-US")} PH` : `${r?.videos ?? 0} of ${RESULTS_TO_COMPARE} videos measured`}</p>
            </li>
          );
        })}
      </ul>
      {board.recommended && (
        <p className="text-sm">
          Next: <span className="font-medium">{philippineTime(board.recommended.at)}</span>
        </p>
      )}
    </section>
  );
}

function AudiencePanel({ audience: a }: { audience: AudienceReport | null }) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="flex items-center gap-2 font-medium">
        <Users className="size-4" /> Who watches
      </h2>
      {!a ? (
        <p className="text-sm text-muted-foreground">capy reads this from YouTube Analytics once a week. It appears here after the first read.</p>
      ) : (
        <>
          <ul className="space-y-1.5 text-sm">
            {a.countries.slice(0, 5).map((c) => {
              const pct = a.totalViews ? (c.views / a.totalViews) * 100 : 0;
              return (
                <li key={c.country} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2">
                  <span className="truncate">{COUNTRY[c.country] ?? c.country}</span>
                  <span className="h-2 overflow-hidden rounded bg-muted">
                    <span className={cn("block h-full", c.country === "PH" ? "bg-primary" : "bg-muted-foreground/40")} style={{ width: `${Math.min(100, pct)}%` }} />
                  </span>
                  <span className="text-right text-xs tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                </li>
              );
            })}
          </ul>
          {a.philippinesAgeGender.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Philippines: {a.philippinesAgeGender.slice(0, 3).map((g) => `${g.gender} ${g.group} ${g.pct.toFixed(0)}%`).join(", ")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">Share of all {a.totalViews.toLocaleString("en-US")} channel views. Age and gender cover signed-in viewers only.</p>
        </>
      )}
    </section>
  );
}
