"use client";
import { useState } from "react";
import { Check, Download, FileText, Image as ImageIcon, Loader2, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Lightbox } from "@/components/publish-panel";
import { api } from "@/hooks/use-job";
import { HOOK_FRAME_SEC, type ClipState } from "@/lib/types";

/**
 * Thumbnail card for a rendered clip: the chosen frame, an expandable picker of candidate frames, and downloads.
 * Picking re-grabs the frame from the rendered mp4 (captions included), so it stays enabled after a render.
 */
export function ThumbnailCard({ jobId, clip }: { jobId: string; clip: ClipState }) {
  const [open, setOpen] = useState(false);
  const [autoRan, setAutoRan] = useState(false);
  const [busy, setBusy] = useState<"gen" | number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const thumb = clip.render.thumbUrl ?? clip.thumbUrl;
  const options = clip.thumbs ?? [];
  const at = clip.thumbAt ?? HOOK_FRAME_SEC;
  // Only a render thumb defaults to the hook frame; a source-footage thumb has no known offset unless picked.
  const chosen = clip.thumbAt ?? (clip.render.thumbUrl ? HOOK_FRAME_SEC : undefined);

  // clip updates arrive over SSE from the parent, so these just await; props carry the new thumbs.
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
  async function choose(sec: number) {
    setBusy(sec);
    setErr(null);
    try {
      await api(`/api/jobs/${jobId}/clips/${clip.n}/thumbs`, { method: "PUT", body: JSON.stringify({ at: sec }) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  function toggle() {
    const next = !open;
    setOpen(next);
    // first open with no candidates: grab them once, without waiting for a click on Regenerate
    if (next && options.length === 0 && !autoRan) {
      setAutoRan(true);
      void generate();
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Thumbnail</h2>
        <a className="text-sm underline" href={`/thumbnails/new?jobId=${encodeURIComponent(jobId)}&clipN=${clip.n}`}>Open Thumbnail Studio</a>
        <Button size="sm" variant="outline" onClick={toggle} aria-expanded={open}>
          <ImageIcon /> {open ? "Hide options" : "See options"}
        </Button>
      </div>

      {thumb ? (
        <div className="flex items-start gap-3">
          <Lightbox src={thumb} title={`Thumbnail · ${at.toFixed(1)}s into the clip`}>
            <button type="button" className="group relative w-28 shrink-0 overflow-hidden rounded-md border transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ aspectRatio: "9/16" }} title="View larger">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumb} alt="Current thumbnail" className="absolute inset-0 size-full object-cover" />
              <span className="absolute inset-0 grid place-items-center bg-black/0 text-white opacity-0 transition-[background-color,opacity] group-hover:bg-black/30 group-hover:opacity-100 group-focus-visible:bg-black/30 group-focus-visible:opacity-100">
                <Maximize2 className="size-5" />
              </span>
            </button>
          </Lightbox>
          <p className="text-sm text-muted-foreground">
            {clip.render.thumbUrl
              ? `${at.toFixed(1)}s into the clip, captions on screen. Upload it under “Thumbnail → Upload file”.`
              : "From the source footage; this render predates thumbnails. Request a re-render to grab one with captions."}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No thumbnail was grabbed from this render.</p>
      )}

      {open && (
        <div className="space-y-2 border-t pt-3">
          {busy === "gen" && options.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Grabbing frames from the clip…
            </p>
          ) : options.length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
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
          ) : (
            <p className="text-sm text-muted-foreground">No candidate frames yet.</p>
          )}
          <Button size="sm" variant="ghost" onClick={generate} disabled={busy !== null} title="Grab a fresh set of frames from the clip">
            {busy === "gen" ? <Loader2 className="animate-spin" /> : <ImageIcon />} Regenerate options
          </Button>
        </div>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}

      {(thumb || clip.render.textUrl) && (
        <div className="space-y-1.5 border-t pt-3">
          <Label>Files</Label>
          <div className="flex flex-wrap gap-2">
            {thumb && (
              <Button size="sm" variant="outline" asChild>
                <a href={thumb.split("?")[0]} download>
                  <Download /> Thumbnail
                </a>
              </Button>
            )}
            {clip.render.textUrl && (
              <Button size="sm" variant="outline" asChild>
                <a href={clip.render.textUrl} download>
                  <FileText /> .txt
                </a>
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
