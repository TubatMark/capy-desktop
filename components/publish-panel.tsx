"use client";
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, Download, Loader2, Lock, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { api } from "@/hooks/use-job";
import type { ClipState } from "@/lib/types";

type Publish = NonNullable<ClipState["publish"]>;

/** YouTube upload text for one clip (edit, copy, regenerate). */
export function PublishPanel({ jobId, clip, locked = false }: { jobId: string; clip: ClipState; locked?: boolean }) {
  const [p, setP] = useState<Publish | null>(clip.publish ?? null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"gen" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // adopt server changes (e.g. after regenerate) unless the user is mid-edit
  useEffect(() => {
    if (!dirty && clip.publish) setP(clip.publish);
  }, [clip.publish, dirty]);

  async function generate() {
    setBusy("gen");
    setErr(null);
    try {
      const c = await api<ClipState>(`/api/jobs/${jobId}/clips/${clip.n}/publish`, { method: "POST" });
      setP(c.publish ?? null);
      setDirty(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    if (!p) return;
    setBusy("save");
    try {
      await api(`/api/jobs/${jobId}/clips/${clip.n}`, { method: "PATCH", body: JSON.stringify({ publish: p }) });
      setDirty(false);
    } finally {
      setBusy(null);
    }
  }
  const edit = (patch: Partial<Publish>) => {
    setP((x) => (x ? { ...x, ...patch } : x));
    setDirty(true);
  };
  const tags = p ? p.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ") : "";

  return (
    <div className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold">
          Publish to YouTube {locked && <Lock className="size-3.5 text-muted-foreground" aria-label="Locked: rendered" />}
        </h2>
        <Button size="sm" variant="outline" onClick={generate} disabled={busy !== null || locked}>
          {busy === "gen" ? <Loader2 className="animate-spin" /> : <Sparkles />} {p ? "Regenerate" : "Generate with AI"}
        </Button>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      {!p ? (
        <p className="text-sm text-muted-foreground">No upload text yet for this clip. Generate it and AI will write a title, description and hashtags from the transcript.</p>
      ) : (
        <>
          <Field label="Title" value={p.ytTitle} hint={`${p.ytTitle.length}/100`}>
            <Input value={p.ytTitle} maxLength={100} onChange={(e) => edit({ ytTitle: e.target.value })} disabled={locked} />
          </Field>
          <Field label="Description" value={p.description}>
            <Textarea value={p.description} rows={6} onChange={(e) => edit({ description: e.target.value })} disabled={locked} />
          </Field>
          <Field label="Hashtags" value={tags}>
            <Input value={p.hashtags.join(" ")} onChange={(e) => edit({ hashtags: e.target.value.split(/[\s,]+/).filter(Boolean).map((h) => h.replace(/^#/, "")) })} placeholder="tota rakai brazil shorts" disabled={locked} />
          </Field>
          {dirty && !locked && (
            <Button size="sm" onClick={save} disabled={busy !== null}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />} Save text
            </Button>
          )}
        </>
      )}

      {locked && <a className="text-sm underline" href={`/thumbnails/new?jobId=${encodeURIComponent(jobId)}&clipN=${clip.n}`}>Edit thumbnail and attach an exact version</a>}
      {locked && <p className="text-xs text-muted-foreground">This clip is rendered. Request a re-render to change upload text. Edit and download a thumbnail in Thumbnail Studio.</p>}
    </div>
  );
}

/** Click the child to open `src` full size in a dialog. Shared with the posting sheet. */
export function Lightbox({ src, title, children }: { src: string; title: string; children: React.ReactNode }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="text-sm text-white/80">{title}</Dialog.Title>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="Thumbnail" className="max-h-[80vh] rounded-xl border border-white/20 shadow-2xl" style={{ aspectRatio: "9/16" }} />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" asChild>
              <a href={src.split("?")[0]} download>
                <Download /> Download
              </a>
            </Button>
            <Dialog.Close asChild>
              <Button size="sm" variant="secondary">
                <X /> Close
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, value, hint, children }: { label: string; value: string; hint?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>
          {label} {hint && <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">{hint}</span>}
        </Label>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? "copied" : "copy"}
        </button>
      </div>
      {children}
    </div>
  );
}
