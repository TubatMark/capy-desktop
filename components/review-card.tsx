"use client";
import { queueGroup, queueLink } from "@/lib/queue-source";
import { useState } from "react";
import Link from "next/link";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PLATFORM_NAME } from "@/components/accounts-panel";
import { AiReview } from "@/components/ai-review";
import { SeoScore } from "@/components/seo-score";
import { ThumbnailChoices } from "@/components/queue/thumbnail-choices";
import { SimilarClips } from "@/components/queue/similar-clips";
import { api } from "@/hooks/use-job";
import { fmtSlot } from "@/hooks/use-queue";
import type { Platform, PostText, QueueEntry } from "@/lib/types";

/** One rendered clip waiting for the user's OK: watch it, pick platforms, tweak the text, approve or reject. */
export function ReviewCard({
  entries,
  nextFree,
  tz,
  onDone,
  clips,
  onOpenClip,
}: {
  entries: QueueEntry[];
  nextFree?: number;
  tz: string;
  onDone: (msg?: string) => void;
  /** Live queue entries by queue group (for the similar clips' state and picture). */
  clips?: Map<string, QueueEntry[]>;
  onOpenClip?: (id: string) => void;
}) {
  const first = entries[0]!;
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(entries.map((e) => [e.platform, true])));
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const chosen = entries.filter((e) => on[e.platform]).map((e) => e.platform);

  const aiReview = entries.find((e) => e.aiReview)?.aiReview;
  const seo = entries.find((e) => e.seo)?.seo;
  const youtube = entries.find((e) => e.platform === "youtube");
  const similarity = entries.find((e) => e.similarity)?.similarity;

  async function approve() {
    if (aiReview?.verdict === "block" && !window.confirm("The AI reviewer flagged this clip as not safe to post as is. Post it anyway?")) return;
    setBusy("approve");
    setErr(null);
    try {
      const r = await api<{ scheduled: QueueEntry[] }>("/api/queue/approve", { method: "POST", body: JSON.stringify({ ...(first.source ? {group:queueGroup(first)} : {jobId:first.jobId,n:first.n}), platforms: chosen, force: aiReview?.verdict === "block" }) });
      const at = r.scheduled[0]?.slotAt;
      onDone(at ? `"${first.clipTitle}" scheduled for ${fmtSlot(at, tz)}` : "No free slot in the next 14 days");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function reject() {
    setBusy("reject");
    try {
      for (const e of entries) await api(`/api/queue/${encodeURIComponent(e.key)}/reject`, { method: "POST" });
      onDone();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div id={`review-${queueGroup(first)}`} className="grid scroll-mt-4 gap-4 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
      <video src={first.videoUrl} poster={first.thumbUrl} controls preload="metadata" className="aspect-[9/16] w-full max-w-[200px] rounded-lg bg-black object-contain" />
      <div className="min-w-0 space-y-3">
        <div>
          <Link href={queueLink(first)} className="font-semibold hover:underline">
            {first.clipTitle}
          </Link>
          {first.madeForKids && <span className="ml-2 inline-block rounded-md bg-sky-500/15 px-1.5 py-0.5 align-middle text-xs font-medium text-sky-800">Made for kids</span>}
        </div>
        <ThumbnailChoices entries={entries} onChange={onDone} />
        {seo && <SeoScore seo={seo} />}
        {aiReview && (
          <AiReview
            review={aiReview}
            onUseTitle={
              youtube
                ? async (title) => {
                    await api(`/api/queue/${encodeURIComponent(youtube.key)}`, { method: "PATCH", body: JSON.stringify({ text: { title } }) });
                    onDone(`Title updated: ${title}`);
                  }
                : undefined
            }
          />
        )}
        {similarity && <SimilarClips similarity={similarity} recheckKey={first.key} clips={clips} onOpen={onOpenClip} onChange={onDone} />}
        {entries.map((e) => (
          // remount when the entry changes on the server (e.g. "Use it" on the AI title) so the fields show it
          <PlatformText key={`${e.key}:${e.updatedAt}`} entry={e} enabled={on[e.platform] ?? false} onToggle={(v) => setOn((s) => ({ ...s, [e.platform]: v }))} />
        ))}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={approve} disabled={busy !== null || chosen.length === 0}>
            {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} {aiReview?.verdict === "block" ? "Post anyway…" : "Approve"}
          </Button>
          <Button size="sm" variant="outline" onClick={reject} disabled={busy !== null}>
            {busy === "reject" ? <Loader2 className="animate-spin" /> : <X />} Reject
          </Button>
          {nextFree && <span className="text-xs text-muted-foreground">Next free slot: {fmtSlot(nextFree, tz)}</span>}
        </div>
      </div>
    </div>
  );
}

function PlatformText({ entry, enabled, onToggle }: { entry: QueueEntry; enabled: boolean; onToggle: (v: boolean) => void }) {
  const [text, setText] = useState<PostText>(entry.text);
  const save = (patch: PostText) => void api(`/api/queue/${encodeURIComponent(entry.key)}`, { method: "PATCH", body: JSON.stringify({ text: patch }) }).catch(() => {});
  const p: Platform = entry.platform;
  return (
    <details className="rounded-lg border px-3 py-2" open={false}>
      <summary className="flex cursor-pointer select-none items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-[var(--primary)]"
          checked={enabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={`Post to ${PLATFORM_NAME[p]}`}
        />
        <span className="font-medium">{PLATFORM_NAME[p]}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{p === "youtube" ? text.title : text.caption?.split("\n")[0]}</span>
      </summary>
      <div className="mt-2 space-y-2">
        {p === "youtube" ? (
          <>
            <Label>Title ({(text.title ?? "").length}/100)</Label>
            <Input value={text.title ?? ""} maxLength={100} onChange={(e) => setText({ ...text, title: e.target.value })} onBlur={() => save({ title: text.title })} />
            <Label>Description</Label>
            <Textarea rows={4} value={text.description ?? ""} onChange={(e) => setText({ ...text, description: e.target.value })} onBlur={() => save({ description: text.description })} />
          </>
        ) : (
          <>
            <Label>Caption ({(text.caption ?? "").length}/2200)</Label>
            <Textarea rows={5} maxLength={2200} value={text.caption ?? ""} onChange={(e) => setText({ ...text, caption: e.target.value })} onBlur={() => save({ caption: text.caption })} />
          </>
        )}
      </div>
    </details>
  );
}
