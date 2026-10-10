"use client";
import { useEffect, useMemo, useState } from "react";
import { Check, CloudUpload, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Gauge } from "@/components/gauge";
import { api } from "@/hooks/use-job";
import { scoreSeo, type SeoKind } from "@/src/seo/score";
import type { ChannelVideo, SeoCheck, SeoText, VideoSeoSuggestion } from "@/lib/types";

const kindOf = (v: ChannelVideo): SeoKind => (v.madeForKids ? "kids" : v.duration <= 180 ? "short" : "video");
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim().replace(/^#/, ""))
    .filter(Boolean);

/**
 * One video's text next to a search-tuned rewrite. The rewrite is editable and re-scored as you type; nothing
 * changes on YouTube until "Update on YouTube".
 */
export function ImprovePanel({ video, canEdit, onUpdated, onClose }: { video: ChannelVideo; canEdit: boolean; onUpdated: (v: ChannelVideo) => void; onClose: () => void }) {
  const [s, setS] = useState<VideoSeoSuggestion | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; description: string; hashtags: string; tags: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setS(null);
    setErr(null);
    api<VideoSeoSuggestion>(`/api/channel/videos/${video.id}/seo`, { method: "POST" })
      .then((r) => {
        if (!live) return;
        setS(r);
        setDraft({ title: r.suggested.title, description: r.suggested.description, hashtags: r.suggested.hashtags.join(", "), tags: r.suggested.tags.join(", ") });
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [video.id, round]);

  const text: SeoText | null = draft && { title: draft.title, description: draft.description, hashtags: list(draft.hashtags), tags: list(draft.tags) };
  const live = useMemo(() => (text ? scoreSeo(text, { keyword: s?.keyword, kind: kindOf(video) }) : null), [text?.title, text?.description, draft?.hashtags, draft?.tags, s?.keyword, video]); // eslint-disable-line react-hooks/exhaustive-deps

  async function update() {
    if (!text) return;
    setSaving(true);
    setErr(null);
    try {
      const v = await api<ChannelVideo>(`/api/channel/videos/${video.id}`, { method: "PUT", body: JSON.stringify(text) });
      setDone(true);
      onUpdated(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!s || !draft || !live)
    return (
      <div className="flex flex-wrap items-center gap-3 px-4 py-5 text-sm">
        {err ? (
          <>
            <span className="text-red-700">{err}</span>
            <Button size="sm" variant="outline" onClick={() => setRound(round + 1)}>
              <RefreshCw /> Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Researching what people search and rewriting the text. This takes about half a minute.
          </span>
        )}
      </div>
    );

  return (
    <div className="space-y-4 px-4 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          {s.keyword ? (
            <>
              Target search: <span className="font-semibold">“{s.keyword}”</span>
            </>
          ) : (
            "No clear search to target"
          )}
          {s.research?.notes.length ? <span className="text-muted-foreground"> · {s.research.notes.join(" ")}</span> : null}
        </p>
        <button type="button" onClick={onClose} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <X className="size-4" /> Close
        </button>
      </div>

      <p className="text-xs text-muted-foreground">Local editorial checks of this text; not provider performance rankings.</p>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <Gauge value={s.before.score} label="Now" />
            <Checks checks={s.before.checks} />
          </div>
          <div className="space-y-2 rounded-lg bg-muted/60 p-3 text-sm">
            <p className="font-medium">{s.current.title}</p>
            <p className="line-clamp-6 whitespace-pre-line text-muted-foreground">{s.current.description || "No description"}</p>
            <p className="text-xs text-muted-foreground">Tags: {s.current.tags.length ? s.current.tags.join(", ") : "none"}</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <Gauge value={live.score} label="Suggested" hint={live.score > s.before.score ? `+${live.score - s.before.score} points` : undefined} />
            <Checks checks={live.checks} />
          </div>
          <div className="space-y-2.5">
            <Field label={`Title (${draft.title.length}/100)`}>
              <Input value={draft.title} maxLength={100} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <Field label="Description">
              <Textarea rows={5} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Field label="Hashtags">
                <Input value={draft.hashtags} onChange={(e) => setDraft({ ...draft, hashtags: e.target.value })} />
              </Field>
              <Field label="Search tags">
                <Input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
              </Field>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        {done ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--gauge-good)]">
            <Check className="size-4" /> Updated on YouTube
          </span>
        ) : (
          <Button onClick={update} disabled={saving || !canEdit || !draft.title.trim()}>
            {saving ? <Loader2 className="animate-spin" /> : <CloudUpload />} Update on YouTube
          </Button>
        )}
        <Button variant="outline" onClick={() => setRound(round + 1)} disabled={saving}>
          <RefreshCw /> Another suggestion
        </Button>
        {!canEdit && <span className="text-xs text-muted-foreground">Reconnect YouTube in Settings → Accounts to let capy edit videos.</span>}
        {err && <span className="text-sm text-red-700">{err}</span>}
      </div>
    </div>
  );
}

function Checks({ checks }: { checks: SeoCheck[] }) {
  const failed = checks.filter((c) => !c.pass);
  if (!failed.length) return <p className="text-sm text-muted-foreground">Every check passes.</p>;
  return (
    <ul className="min-w-0 space-y-1 text-xs">
      {failed.slice(0, 4).map((c) => (
        <li key={c.id} className="flex gap-1.5" title={c.tip}>
          <X className="mt-px size-3.5 shrink-0 text-[var(--gauge-poor)]" />
          <span className="min-w-0">{c.label}</span>
        </li>
      ))}
      {failed.length > 4 && <li className="pl-5 text-muted-foreground">and {failed.length - 4} more</li>}
    </ul>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
