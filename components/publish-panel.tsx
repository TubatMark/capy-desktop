"use client";
import { useEffect, useState } from "react";
import { Check, Copy, Download, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { api } from "@/hooks/use-job";
import type { ClipState } from "@/lib/types";

type Publish = NonNullable<ClipState["publish"]>;

/** YouTube upload text + thumbnail for one clip: edit, copy, regenerate. */
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
  const thumb = clip.render.thumbUrl;

  return (
    <div className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Publish to YouTube</h2>
        <Button size="sm" variant="outline" onClick={generate} disabled={busy !== null}>
          {busy === "gen" ? <Loader2 className="animate-spin" /> : <Sparkles />} {p ? "Regenerate" : "Generate with AI"}
        </Button>
      </div>
      {err && <p className="break-words text-xs text-red-300">{err}</p>}
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

      <div className="border-t pt-4">
        <Label>Thumbnail</Label>
        {thumb ? (
          <div className="mt-2 flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumb} alt="" className="w-20 shrink-0 rounded-md border sm:w-24" style={{ aspectRatio: "9/16", objectFit: "cover" }} />
            <div className="min-w-0 space-y-2 text-sm text-muted-foreground">
              <p className="text-pretty">Grabbed from the rendered clip with the hook on screen. Upload it under “Thumbnail → Upload file”.</p>
              <div className="flex flex-wrap gap-2">
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
            </div>
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Render the clip to get a thumbnail (a frame with the hook on screen).</p>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, hint, children }: { label: string; value: string; hint?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="min-w-0 truncate">
          {label} {hint && <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">{hint}</span>}
        </Label>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:text-foreground max-md:min-h-10"
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
