"use client";
import { useState } from "react";
import { Check, Copy, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api } from "@/hooks/use-job";
import type { ClipState } from "@/lib/types";

/**
 * The rendered clip's upload text: title, description and hashtags to paste into YouTube Studio, read-only.
 * Each field copies with one click (or click the block to select it all).
 */
export function PostTextCard({ jobId, clip }: { jobId: string; clip: ClipState }) {
  const p = clip.publish;
  const tags = p ? p.hashtags.map((h) => `#${h.replace(/^#/, "")}`) : [];

  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Post to YouTube</h2>
        <p className="text-xs text-muted-foreground">Copy each field into YouTube Studio</p>
      </div>

      {p ? (
        <>
          <CopyField label="Title" hint={`${p.ytTitle.length}/100`} value={p.ytTitle} />
          <CopyField label="Description" value={p.description} multiline />
          <CopyField label="Hashtags" value={tags.join(" ")}>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <span key={t} className="rounded-md bg-muted px-2 py-0.5 text-xs">
                  {t}
                </span>
              ))}
            </div>
          </CopyField>
        </>
      ) : (
        <GenerateText jobId={jobId} n={clip.n} />
      )}
    </section>
  );
}

/** A rendered clip without upload text yet: generating it only writes the .txt next to the mp4, no re-render. */
function GenerateText({ jobId, n }: { jobId: string; n: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/jobs/${jobId}/clips/${n}/publish`, { method: "POST" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-4">
      <p className="text-sm text-muted-foreground">No upload text for this clip yet. AI writes the title, description and hashtags from the transcript.</p>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <Button size="sm" onClick={generate} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Generate with AI
      </Button>
    </div>
  );
}

function CopyField({ label, hint, value, multiline, children }: { label: string; hint?: string; value: string; multiline?: boolean; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>
          {label} {hint && <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">{hint}</span>}
        </Label>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? "copied" : "copy"}
        </button>
      </div>
      {children ?? <div className={"select-all rounded-md border bg-background/60 px-3 py-2 text-sm leading-relaxed " + (multiline ? "whitespace-pre-wrap" : "")}>{value}</div>}
    </div>
  );
}
