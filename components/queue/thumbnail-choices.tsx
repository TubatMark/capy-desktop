"use client";
import { useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { api } from "@/hooks/use-job";
import type { QueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

const LAYOUT = { original: "Original", bold: "Bold", editorial: "Editorial", minimal: "Minimal" } as const;

/** The designed thumbnails for a clip's YouTube post: the one that uploads with the video is ticked; picking
 *  another swaps it (a scheduled post goes back to waiting for your OK). */
export function ThumbnailChoices({
  entries,
  onChange,
}: {
  entries: QueueEntry[];
  onChange: (msg?: string) => void;
}) {
  const yt = entries.find((e) => e.platform === "youtube" && e.thumbnailOptions?.length);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!yt) return null;
  const locked = ["posting", "posted"].includes(yt.status);

  async function pick(designId: string) {
    if (!yt) return;
    if (
      yt.status === "scheduled" &&
      !window.confirm("Changing the thumbnail takes this clip off the schedule until you approve it again. Change it?")
    )
      return;
    setBusy(designId);
    setErr(null);
    try {
      await api(`/api/queue/${encodeURIComponent(yt.key)}/thumbnail`, {
        method: "POST",
        body: JSON.stringify({ designId }),
      });
      onChange(yt.status === "scheduled" ? "Thumbnail changed; approve the clip again to schedule it" : "Thumbnail changed");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2" role="group" aria-label="Thumbnail">
      <p className="text-xs text-muted-foreground">
        {locked
          ? "The thumbnail sent with this video."
          : "The ticked one uploads with the video. Click another to use it instead."}
      </p>
      <div className="flex gap-2">
        {yt.thumbnailOptions!.map((o) => (
          <button
            key={o.designId}
            type="button"
            disabled={locked || o.attached || busy !== null}
            onClick={() => void pick(o.designId)}
            aria-pressed={o.attached}
            aria-label={`${LAYOUT[o.layout]} thumbnail${o.headline ? `: ${o.headline}` : ""}${o.attached ? " (in use)" : ""}`}
            className={cn(
              "relative w-20 shrink-0 overflow-hidden rounded-lg border-2 transition-[border-color,opacity] disabled:cursor-default",
              o.attached ? "border-primary" : "border-transparent opacity-80 hover:opacity-100 enabled:hover:border-border",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={o.url} alt="" className="aspect-[9/16] w-full bg-muted object-cover" />
            <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-[10px] font-medium text-white">
              {LAYOUT[o.layout]}
            </span>
            {o.attached && (
              <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
                <Check className="size-3" />
              </span>
            )}
            {o.aiChoice && (
              <span className="absolute left-1 top-1 rounded bg-black/65 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-white">
                AI pick
              </span>
            )}
            {o.pickedBy === "ai" && !o.attached && (
              <Sparkles className="absolute right-1 top-1 size-3.5 text-white drop-shadow" aria-hidden />
            )}
            {busy === o.designId && (
              <span className="absolute inset-0 grid place-items-center bg-black/40">
                <Loader2 className="size-4 animate-spin text-white" />
              </span>
            )}
          </button>
        ))}
      </div>
      {(() => {
        const best = yt.thumbnailOptions!.find((o) => o.aiChoice);
        return best ? (
          <p className="text-xs">
            <span className="font-medium">AI reviewer picked {LAYOUT[best.layout]}</span>
            {best.aiReason ? <span className="text-muted-foreground">: {best.aiReason}</span> : null}
          </p>
        ) : null;
      })()}
      {yt.thumbnailOptions!.some((o) => o.pickedBy === "ai") && (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Sparkles className="size-3" /> Frame and headline picked by AI from this clip.
        </p>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}
