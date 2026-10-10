"use client";
import { useState } from "react";
import Link from "next/link";
import { CircleCheck, Copy, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/hooks/use-job";
import {
  SIMILARITY_AGENTS,
  SIMILARITY_AGENT_NAME,
  looksSimilar,
  type ClipSimilarity,
  type SimilarClipRef,
  type SimilarityLevel,
} from "@/lib/similarity";
import type { QueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEVEL_WORD: Record<SimilarityLevel, string> = {
  "near-duplicate": "Nearly the same",
  similar: "Similar",
  distinct: "Different",
};
const STATE_WORD: Record<string, string> = {
  waiting: "Waiting for your OK",
  scheduled: "Scheduled",
  posted: "Posted",
  rejected: "Rejected",
};
/** A check queued this long ago that never finished is no longer shown as running. */
const CHECK_STALE_MS = 10 * 60_000;

/** Where a linked clip stands now, from the live queue (falls back to the state at check time). */
export function liveClipState(entries: QueueEntry[] | undefined, ref: SimilarClipRef): string {
  if (!entries?.length) return ref.state;
  if (entries.some((e) => e.status === "review")) return "waiting";
  if (entries.some((e) => e.status === "posted" || (e.status === "needs_action" && e.result?.id))) return "posted";
  if (entries.some((e) => e.status !== "rejected")) return "scheduled";
  return "rejected";
}

/**
 * "Similar clips": do the two AIs think this clip looks like others that are waiting, scheduled or recently posted?
 * Shows both verdicts side by side, the linked clips, and what to do; a one-line all-clear when it looks different.
 */
export function SimilarClips({
  similarity,
  recheckKey,
  clips,
  onOpen,
  onChange,
}: {
  similarity: ClipSimilarity;
  /** Queue key for "Check again" (clips waiting for review only). */
  recheckKey?: string;
  /** Live queue entries by queue group, for the linked clips' current state and picture. */
  clips?: Map<string, QueueEntry[]>;
  /** Open a linked clip in the Queue; without it the clip page opens. */
  onOpen?: (id: string) => void;
  onChange?: (msg?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = similarity;
  const checking = s.checking !== undefined && Date.now() - s.checking < CHECK_STALE_MS;

  async function recheck() {
    if (!recheckKey) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/queue/${encodeURIComponent(recheckKey)}/similarity`, { method: "POST" });
      onChange?.("Asking the AI to compare this clip again");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const again = recheckKey ? (
    <button
      type="button"
      onClick={() => void recheck()}
      disabled={busy || checking}
      className="inline-flex items-center gap-1 rounded border border-current/25 px-1.5 py-0.5 text-xs hover:bg-white/40 disabled:opacity-60"
    >
      {busy || checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
      {checking ? "Checking…" : "Check again"}
    </button>
  ) : null;

  if (!s.checkedAt) {
    if (!checking) return null;
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" /> Comparing with your other clips…
      </p>
    );
  }

  if (!looksSimilar(s)) {
    const both = s.opinions.length === 2;
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="Similar clips">
        <p className="flex items-center gap-1.5">
          <CircleCheck className="size-3.5 text-emerald-700" />
          Looks different from your other clips
          {both ? " (Claude and Codex agree)." : s.opinions.length === 1 ? ` (checked by ${SIMILARITY_AGENT_NAME[s.opinions[0]!.by]}).` : "."}
        </p>
        {s.candidates.length > 0 && again}
      </div>
    );
  }

  const v = s.verdict;
  const near = v.level === "near-duplicate";
  const linked = s.candidates.filter((c) => v.similarTo.includes(c.id));
  const shown = linked.length ? linked : s.candidates;
  const heading =
    v.level === "unchecked"
      ? `Possibly similar to ${shown.length} other clip${shown.length === 1 ? "" : "s"}`
      : `${near ? "Nearly the same as" : "Similar to"} ${shown.length} other clip${shown.length === 1 ? "" : "s"}`;
  const agreement =
    v.agreement === "agree"
      ? "Claude and Codex agree."
      : v.agreement === "differ"
        ? "Claude and Codex disagree; the recommendation follows the more careful one."
        : v.agreement === "single"
          ? `Only ${SIMILARITY_AGENT_NAME[s.opinions[0]!.by]} answered; the second opinion was unavailable.`
          : "The AI couldn't give an opinion; these clips came up in a quick check of titles and source videos.";

  return (
    <section
      aria-label="Similar clips"
      className={cn(
        "space-y-2.5 rounded-lg border px-3 py-2.5 text-sm",
        near ? "border-orange-500/40 bg-orange-500/10 text-orange-950" : "border-amber-500/40 bg-amber-500/10 text-amber-950",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-medium">
          <Copy className="size-4 shrink-0" /> Similar clips: {heading}
        </p>
        {again}
      </div>
      {v.recommendation && (
        <p className="text-pretty">
          <span className="font-medium">AI recommends:</span> {v.recommendation}
        </p>
      )}
      <p className="text-xs opacity-80">{agreement}</p>
      {(s.opinions.length > 0 || s.unavailable.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {SIMILARITY_AGENTS.map((by) => {
            const o = s.opinions.find((x) => x.by === by);
            const gone = s.unavailable.find((x) => x.by === by);
            if (!o && !gone) return null;
            return (
              <div key={by} className="space-y-1 rounded-md border border-current/15 bg-white/45 px-2.5 py-2 text-xs" aria-label={`${SIMILARITY_AGENT_NAME[by]}'s opinion`}>
                <p className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{SIMILARITY_AGENT_NAME[by]}</span>
                  {o && <span className="rounded bg-current/10 px-1.5 py-0.5 font-medium">{LEVEL_WORD[o.level]}</span>}
                </p>
                {o ? (
                  <>
                    <p className="text-pretty">{o.why}</p>
                    <p className="text-pretty opacity-80">{o.recommendation}</p>
                  </>
                ) : (
                  <p className="text-pretty opacity-80">Second opinion unavailable: {gone!.reason}.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
      <ul className="flex flex-wrap gap-2" aria-label="Linked clips">
        {shown.map((c) => {
          const live = clips?.get(c.id);
          const thumb = live?.[0]?.thumbUrl ?? c.thumbUrl;
          const state = liveClipState(live, c);
          const body = (
            <>
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt="" className="aspect-[9/16] w-9 shrink-0 rounded object-cover" />
              ) : (
                <span className="aspect-[9/16] w-9 shrink-0 rounded bg-current/10" />
              )}
              <span className="min-w-0 text-left">
                <span className="line-clamp-2 text-xs font-medium leading-snug">{live?.[0]?.clipTitle ?? c.title}</span>
                <span className="block text-[11px] opacity-75">{STATE_WORD[state] ?? state}</span>
              </span>
            </>
          );
          const cls = "flex w-56 max-w-full items-center gap-2 rounded-md border border-current/15 bg-white/45 p-1.5 hover:bg-white/70";
          return (
            <li key={c.id}>
              {onOpen && state !== "rejected" ? (
                <button type="button" className={cls} onClick={() => onOpen(c.id)}>
                  {body}
                </button>
              ) : (
                <Link href={c.link} className={cls}>
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {err && <p className="text-xs text-red-700">{err}</p>}
    </section>
  );
}
