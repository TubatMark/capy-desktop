"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Check, Clapperboard, Loader2, PenLine, RefreshCw, Save, Send, ShieldCheck, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AiReview } from "@/components/ai-review";
import { StatusChip } from "@/components/stories/status-chip";
import { api } from "@/hooks/use-job";
import type { StoryCast, StoryPage, StorySeries, StoryState } from "@/lib/types";

type Data = { story: StoryState; series: StorySeries };
type Voice = { name: string; lang: string };
type Draft = Pick<StoryPage, "text" | "scene" | "cast">[];

const WORKING = new Set(["writing", "illustrating", "rendering"]);
const STEPS = [
  { key: "script", label: "Script" },
  { key: "pages", label: "Pictures" },
  { key: "done", label: "Video" },
] as const;

/** Spread the cast evenly when the user changes who is on a page. */
function respread(cast: StoryCast[]): StoryCast[] {
  return cast.map((c, k) => ({ ...c, x: Math.round(((k + 1) / (cast.length + 1)) * 100) / 100 }));
}

export function StoryStudio({ seriesId, id }: { seriesId: string; id: string }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState("Samantha");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<Data>(`/api/stories/story/${id}`);
      setData(d);
      if (d.story.voice) setVoice(d.story.voice);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
    api<{ voices: Voice[] }>("/api/stories")
      .then((r) => setVoices(r.voices))
      .catch(() => {});
  }, [load]);

  const st = data?.story;
  const working = !!st && (WORKING.has(st.status) || st.pages.some((p) => p.status === "drawing"));
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [working, load]);

  // the editable copy follows the server until the user starts typing
  useEffect(() => {
    if (!st || draft) return;
    setTitle(st.title);
  }, [st, draft]);
  const pages: Draft = draft ?? st?.pages.map((p) => ({ text: p.text, scene: p.scene, cast: p.cast })) ?? [];
  const dirty = !!draft || (!!st && title.trim() !== st.title);
  const names = useMemo(() => Object.fromEntries((data?.series.characters ?? []).map((c) => [c.id, c.name])), [data]);

  async function act(name: string, url: string, body?: unknown, after?: string) {
    setBusy(name);
    setErr(null);
    setMsg(null);
    try {
      await api(url, { method: "POST", body: JSON.stringify(body ?? {}) });
      if (after) setMsg(after);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setErr(null);
    try {
      await api(`/api/stories/story/${id}`, { method: "PATCH", body: JSON.stringify({ title, ...(draft ? { pages: draft } : {}) }) });
      setDraft(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!data || !st)
    return err ? (
      <p className="text-sm text-red-600">{err}</p>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );

  const editable = !working && ["script", "pages", "done"].includes(st.status);
  const allPictures = st.pages.length > 0 && st.pages.every((p) => p.status === "ready");
  const stepIndex = st.status === "done" ? 2 : st.status === "pages" || st.status === "rendering" || st.status === "illustrating" ? 1 : 0;
  const lastLog = st.log.at(-1)?.msg;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href={`/stories/${seriesId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {data.series.title}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} className="h-auto max-w-xl border-transparent bg-transparent px-0 text-2xl font-semibold shadow-none focus-visible:border-input focus-visible:px-2" aria-label="Story title" />
          <StatusChip story={st} />
        </div>
        <p className="text-sm text-muted-foreground">{st.brief}</p>
        <ol className="flex flex-wrap items-center gap-2 text-xs">
          {STEPS.map((s, i) => (
            <li key={s.key} className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${i < stepIndex ? "bg-emerald-500/15 text-emerald-800" : i === stepIndex ? "bg-primary/15 font-medium text-foreground" : "bg-muted text-muted-foreground"}`}>
              {i < stepIndex ? <Check className="size-3" /> : <span className="tabular-nums">{i + 1}</span>} {s.label}
            </li>
          ))}
          <li className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${st.queuedAt ? "bg-emerald-500/15 text-emerald-800" : "bg-muted text-muted-foreground"}`}>
            {st.queuedAt ? <Check className="size-3" /> : <span>4</span>} Queue
          </li>
        </ol>
      </div>

      {working && (
        <p className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <Loader2 className="size-4 animate-spin text-primary" />
          {st.status === "writing" ? "Writing the story and checking it for kids…" : st.status === "illustrating" ? `Drawing the pages (${st.pages.filter((p) => p.status === "ready").length}/${st.pages.length})…` : "Narrating and making the video…"}
          {lastLog && <span className="truncate text-xs text-muted-foreground">· {lastLog}</span>}
        </p>
      )}
      {st.error && (
        <p className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-800">
          <AlertTriangle className="size-4 shrink-0" /> {st.error}
        </p>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}
      {msg && <p className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm">{msg}</p>}

      {st.review && (
        <div className={`space-y-1 rounded-lg border px-3 py-2 text-sm ${st.review.verdict === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-900" : st.review.verdict === "block" ? "border-red-500/40 bg-red-500/10 text-red-800" : "border-amber-500/40 bg-amber-500/10 text-amber-900"}`}>
          <p className="flex items-center gap-1.5 font-medium">
            <ShieldCheck className="size-4" /> Story reviewer: {st.review.verdict === "ok" ? "safe and ready for little ones" : st.review.verdict === "block" ? "not suitable; rewrite it" : "a few things to fix"}
          </p>
          {st.review.notes.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {st.review.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          {st.review.verdict !== "ok" && st.review.notes.length > 0 && editable && (
            <Button size="sm" variant="outline" className="mt-1" disabled={busy !== null} onClick={() => act("rewrite", `/api/stories/story/${id}/rewrite`, { notes: st.review!.notes })}>
              <Wand2 /> Fix these with AI
            </Button>
          )}
        </div>
      )}

      {st.pages.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Pages</h2>
            <div className="flex flex-wrap gap-2">
              {dirty && editable && (
                <Button size="sm" onClick={save} disabled={busy !== null}>
                  {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />} Save changes
                </Button>
              )}
              {(st.status === "script" || (st.status === "pages" && !allPictures)) && !dirty && (
                <Button size="sm" onClick={() => act("approve", `/api/stories/story/${id}/approve`)} disabled={busy !== null || st.review?.verdict === "block"}>
                  {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} {st.status === "script" ? "Approve script & draw the pages" : "Draw the missing pages"}
                </Button>
              )}
            </div>
          </div>
          <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {pages.map((p, i) => {
              const live = st.pages[i];
              return (
                <li key={i} className="flex gap-3 rounded-xl border bg-card p-3">
                  <div className="relative aspect-[9/16] w-24 shrink-0 overflow-hidden rounded-md bg-muted">
                    {live?.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={live.imageUrl} alt={`Page ${i + 1}`} className="size-full object-cover" />
                    )}
                    {live?.status === "drawing" && (
                      <div className="absolute inset-0 grid place-items-center bg-background/60">
                        <Loader2 className="size-5 animate-spin text-primary" />
                      </div>
                    )}
                    {live?.status === "error" && (
                      <div className="absolute inset-0 grid place-items-center bg-red-500/10" title={live.error}>
                        <AlertTriangle className="size-5 text-red-600" />
                      </div>
                    )}
                    <span className="absolute left-1 top-1 rounded bg-background/80 px-1 text-[10px] font-medium tabular-nums">{i + 1}</span>
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Textarea
                      rows={3}
                      value={p.text}
                      disabled={!editable}
                      aria-label={`Page ${i + 1} words`}
                      onChange={(e) => setDraft(pages.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
                      className="text-sm"
                    />
                    <Textarea
                      rows={2}
                      value={p.scene}
                      disabled={!editable}
                      aria-label={`Page ${i + 1} picture`}
                      onChange={(e) => setDraft(pages.map((x, k) => (k === i ? { ...x, scene: e.target.value } : x)))}
                      className="text-xs text-muted-foreground"
                    />
                    <div className="flex flex-wrap items-center gap-1">
                      {data.series.characters.map((c) => {
                        const on = p.cast.some((x) => x.id === c.id);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            disabled={!editable}
                            onClick={() => setDraft(pages.map((x, k) => (k !== i ? x : { ...x, cast: respread(on ? x.cast.filter((y) => y.id !== c.id) : [...x.cast, { id: c.id, x: 0.5 }].slice(0, 3)) })))}
                            className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-primary/50 bg-primary/15 text-foreground" : "text-muted-foreground"} disabled:opacity-60`}
                            aria-pressed={on}
                          >
                            {names[c.id]}
                          </button>
                        );
                      })}
                      {live?.status === "ready" && editable && !dirty && (
                        <button type="button" className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" disabled={busy !== null} onClick={() => act(`redraw${i}`, `/api/stories/story/${id}/redraw`, { page: i })}>
                          <RefreshCw className="size-3" /> Draw again
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {editable && (
        <section className="space-y-2 rounded-xl border bg-card p-4">
          <Label htmlFor="notes">Want changes? Tell the writer</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. make it rhyme, give Lulu a bigger part, end at bedtime" />
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={async () => {
                await act("rewrite", `/api/stories/story/${id}/rewrite`, { notes: notes.trim() ? [notes.trim()] : [] });
                setNotes("");
                setDraft(null);
              }}
            >
              <PenLine /> {notes.trim() ? "Rewrite with notes" : "Write it again"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Rewriting replaces the script; pages whose picture changes get drawn again.</p>
        </section>
      )}

      {(st.status === "pages" || st.status === "done" || st.status === "rendering") && allPictures && (
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <h2 className="font-semibold">Narration and video</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-48 flex-col gap-1.5">
              <Label htmlFor="voice">Narrator</Label>
              <Select id="voice" value={voice} onChange={(e) => setVoice(e.target.value)} disabled={working}>
                {(voices.length ? voices : [{ name: "Samantha", lang: "en_US" }]).map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button onClick={() => act("render", `/api/stories/story/${id}/render`, { voice })} disabled={busy !== null || working || dirty}>
              {busy === "render" || st.status === "rendering" ? <Loader2 className="animate-spin" /> : <Clapperboard />} {st.video ? "Make the video again" : "Narrate & make the video"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Voices come from this computer. Install nicer ones in System Settings → Accessibility → Spoken Content → System voice → Manage Voices.</p>
        </section>
      )}

      {st.video && st.status === "done" && (
        <section className="grid gap-5 rounded-xl border bg-card p-4 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          <video src={st.video.url} poster={st.video.coverUrl} controls className="aspect-[9/16] w-full rounded-lg bg-black" />
          <div className="min-w-0 space-y-4">
            {st.contentReview && <AiReview review={st.contentReview} />}
            {st.publish && (
              <div className="space-y-1 text-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Upload text (for parents)</p>
                <p className="font-medium">{st.publish.ytTitle}</p>
                <p className="whitespace-pre-line text-muted-foreground">{st.publish.description}</p>
                <p className="text-xs text-muted-foreground">{st.publish.hashtags.map((h) => `#${h}`).join(" ")}</p>
                <p className="text-xs text-muted-foreground">YouTube posts it as made for kids (comments and personalised ads off).</p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {st.queuedAt ? (
                <Button asChild variant="outline">
                  <Link href="/queue">
                    <Check /> In Queue: review it there
                  </Link>
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    if (st.contentReview?.verdict === "block" && !window.confirm("The AI reviewer flagged this story. Send it to the queue anyway?")) return;
                    void act("queue", `/api/stories/story/${id}/queue`, {}, "Sent to Queue → Waiting for your OK.");
                  }}
                  disabled={busy !== null}
                >
                  {busy === "queue" ? <Loader2 className="animate-spin" /> : <Send />} Send to Queue for review
                </Button>
              )}
              <Button asChild variant="outline">
                <a href={st.video.url.split("?")[0]} download>
                  Download MP4
                </a>
              </Button>
            </div>
          </div>
        </section>
      )}

      {!working && (
        <div className="pt-4">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={async () => {
              if (!window.confirm(`Delete "${st.title}" and its pictures and video? Anything already posted stays posted.`)) return;
              await api(`/api/stories/story/${id}`, { method: "DELETE" }).catch((e) => setErr(String(e.message ?? e)));
              router.push(`/stories/${seriesId}`);
            }}
          >
            <Trash2 /> Delete story
          </Button>
        </div>
      )}
    </div>
  );
}
