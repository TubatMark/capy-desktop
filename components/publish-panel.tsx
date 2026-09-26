"use client";
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, Download, Image as ImageIcon, Loader2, Maximize2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { api } from "@/hooks/use-job";
import { HOOK_FRAME_SEC, type ClipState } from "@/lib/types";

type Publish = NonNullable<ClipState["publish"]>;

/** YouTube upload text for one clip (edit, copy, regenerate) plus the thumbnail picker. */
export function PublishPanel({ jobId, clip }: { jobId: string; clip: ClipState }) {
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
        <h2 className="font-semibold">Publish to YouTube</h2>
        <Button size="sm" variant="outline" onClick={generate} disabled={busy !== null}>
          {busy === "gen" ? <Loader2 className="animate-spin" /> : <Sparkles />} {p ? "Regenerate" : "Generate with AI"}
        </Button>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      {!p ? (
        <p className="text-sm text-muted-foreground">No upload text yet for this clip. Generate it and AI will write a title, description and hashtags from the transcript.</p>
      ) : (
        <>
          <Field label="Title" value={p.ytTitle} hint={`${p.ytTitle.length}/100`}>
            <Input value={p.ytTitle} maxLength={100} onChange={(e) => edit({ ytTitle: e.target.value })} />
          </Field>
          <Field label="Description" value={p.description}>
            <Textarea value={p.description} rows={6} onChange={(e) => edit({ description: e.target.value })} />
          </Field>
          <Field label="Hashtags" value={tags}>
            <Input value={p.hashtags.join(" ")} onChange={(e) => edit({ hashtags: e.target.value.split(/[\s,]+/).filter(Boolean).map((h) => h.replace(/^#/, "")) })} placeholder="tota rakai brazil shorts" />
          </Field>
          {dirty && (
            <Button size="sm" onClick={save} disabled={busy !== null}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />} Save text
            </Button>
          )}
        </>
      )}

      <ThumbnailPicker jobId={jobId} clip={clip} />
    </div>
  );
}

/** Pick the clip's thumbnail from candidate frames. Before a render the frames come from the source footage. */
function ThumbnailPicker({ jobId, clip }: { jobId: string; clip: ClipState }) {
  const [busy, setBusy] = useState<"gen" | number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rendered = clip.render.status === "done" && !!clip.render.file;
  const footage = rendered || clip.segment?.status === "done";
  const thumb = rendered ? clip.render.thumbUrl : clip.thumbUrl;
  const options = clip.thumbs ?? [];
  const chosen = clip.thumbAt ?? (rendered ? HOOK_FRAME_SEC : undefined);

  async function generate() {
    setBusy("gen");
    setErr(null);
    try {
      await api(`/api/jobs/${jobId}/clips/${clip.n}/thumbs`, { method: "POST" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function choose(at: number) {
    setBusy(at);
    setErr(null);
    try {
      await api(`/api/jobs/${jobId}/clips/${clip.n}/thumbs`, { method: "PUT", body: JSON.stringify({ at }) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between">
        <Label>Thumbnail</Label>
        <Button size="sm" variant="outline" onClick={generate} disabled={!footage || busy !== null} title={footage ? "Grab frames from the clip to choose from" : "Waiting for the footage to download"}>
          {busy === "gen" ? <Loader2 className="animate-spin" /> : <ImageIcon />} {options.length ? "Regenerate options" : "Generate options"}
        </Button>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}

      {options.length > 0 && (
        <div className="grid grid-cols-6 gap-2">
          {options.map((o) => {
            const selected = chosen !== undefined && Math.abs(o.at - chosen) < 0.05;
            return (
              <button
                key={o.at}
                type="button"
                onClick={() => choose(o.at)}
                disabled={busy !== null}
                className={
                  "group relative overflow-hidden rounded-md border-2 bg-black transition-[border-color,transform] hover:-translate-y-0.5 " +
                  (selected ? "border-primary shadow-md" : "border-transparent hover:border-border")
                }
                style={{ aspectRatio: "9/16" }}
                title={`${o.at.toFixed(1)}s into the clip`}
                aria-pressed={selected}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={o.url} alt="" className="absolute inset-0 size-full object-cover" />
                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 font-mono text-[10px] text-white/90">{o.at.toFixed(1)}s</span>
                {busy === o.at && (
                  <span className="absolute inset-0 grid place-items-center bg-black/50 text-white">
                    <Loader2 className="size-4 animate-spin" />
                  </span>
                )}
                {selected && busy !== o.at && (
                  <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                    <Check className="size-3" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {thumb ? (
        <div className="flex items-start gap-3">
          <Lightbox src={thumb} title={`Thumbnail · ${chosen !== undefined ? `${chosen.toFixed(1)}s into the clip` : "hook frame"}`}>
            <button type="button" className="group relative w-20 shrink-0 overflow-hidden rounded-md border transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ aspectRatio: "9/16" }} title="View larger">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumb} alt="Current thumbnail" className="absolute inset-0 size-full object-cover" />
              <span className="absolute inset-0 grid place-items-center bg-black/0 text-white opacity-0 transition-[background-color,opacity] group-hover:bg-black/30 group-hover:opacity-100 group-focus-visible:bg-black/30 group-focus-visible:opacity-100">
                <Maximize2 className="size-5" />
              </span>
            </button>
          </Lightbox>
          <div className="space-y-2 text-sm text-muted-foreground">
            {rendered ? (
              <p>Grabbed from the rendered clip with captions on screen. Upload it under “Thumbnail → Upload file”.</p>
            ) : (
              <p>Options come from the source footage. Once the clip is rendered, the thumbnail is regrabbed from the render at the same moment, captions included.</p>
            )}
            {rendered && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" asChild>
                  <a href={thumb.split("?")[0]} download>
                    <Download /> Thumbnail
                  </a>
                </Button>
                {clip.render.textUrl && (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={clip.render.textUrl} download>
                      <Download /> .txt
                    </a>
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{footage ? "Generate options and pick the frame you want as the thumbnail." : "The thumbnail comes from the clip's footage once it has downloaded."}</p>
      )}
    </div>
  );
}

/** Click the child to open `src` full size in a dialog. */
function Lightbox({ src, title, children }: { src: string; title: string; children: React.ReactNode }) {
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
