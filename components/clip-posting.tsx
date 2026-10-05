"use client";
import { useState } from "react";
import Link from "next/link";
import { CalendarClock, Check, ExternalLink, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostTime } from "@/components/post-time";
import { PLATFORM_NAME } from "@/components/accounts-panel";
import { AiReview } from "@/components/ai-review";
import { api } from "@/hooks/use-job";
import { fmtSlot, useQueue } from "@/hooks/use-queue";
import type { ContentReview, QueueEntry } from "@/lib/types";

const LABEL: Record<QueueEntry["status"], string> = {
  review: "waiting for your OK",
  scheduled: "scheduled",
  posting: "posting now",
  posted: "posted",
  needs_action: "needs action",
  failed: "failed",
  rejected: "rejected",
};

/** This clip's posting: its own slot and status per platform, or Approve/Reject while it waits for review. */
export function ClipPosting({ jobId, n, review }: { jobId: string; n: number; review?: ContentReview }) {
  const { data, refresh } = useQueue();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const mine = data?.entries.filter((e) => e.jobId === jobId && e.n === n && e.status !== "rejected") ?? [];
  if (!data || mine.length === 0)
    return (
      <>
        {review && <AiReview review={review} />}
        <PostTime />
      </>
    );
  const tz = data.audienceTz;
  const waiting = mine.filter((e) => e.status === "review");
  const slot = mine.find((e) => e.slotAt && e.status !== "review")?.slotAt;
  const aiReview = mine.find((e) => e.aiReview)?.aiReview ?? review;

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <CalendarClock className="size-4 text-primary" /> Posting
      </h2>
      {aiReview && <AiReview review={aiReview} />}
      {waiting.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground">
            Approve to schedule{data.nextFree ? ` (next free: ${fmtSlot(data.nextFree, tz)})` : ""}. Edit the text per platform in{" "}
            <Link href="/queue" className="underline underline-offset-2">
              Queue
            </Link>
            .
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("approve");
                await api("/api/queue/approve", { method: "POST", body: JSON.stringify({ jobId, n }) }).catch(() => {});
                setBusy(null);
                void refresh();
              }}
            >
              {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("reject");
                for (const e of waiting) await api(`/api/queue/${encodeURIComponent(e.key)}/reject`, { method: "POST" }).catch(() => {});
                setBusy(null);
                void refresh();
              }}
            >
              {busy === "reject" ? <Loader2 className="animate-spin" /> : <X />} Reject
            </Button>
          </div>
        </>
      ) : (
        slot && <p className="font-mono text-lg tabular-nums">{fmtSlot(slot, tz)}</p>
      )}
      <ul className="space-y-1 text-sm">
        {mine.map((e) => (
          <li key={e.key} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{PLATFORM_NAME[e.platform]}</span>
            <span className="text-muted-foreground">{LABEL[e.status]}</span>
            {e.result?.url && (
              <a href={e.result.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-2">
                open <ExternalLink className="size-3" />
              </a>
            )}
            {(e.result?.note ?? e.error) && e.status !== "posted" && <span className="w-full text-xs text-amber-800">{e.result?.note ?? e.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
