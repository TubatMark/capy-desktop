"use client";
import { useState } from "react";
import { Bot, Check } from "lucide-react";
import type { ContentReview } from "@/lib/types";

const TONE: Record<ContentReview["verdict"], { label: string; cls: string }> = {
  ok: { label: "AI review: looks good", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800" },
  caution: { label: "AI review: check this", cls: "border-amber-500/40 bg-amber-500/10 text-amber-900" },
  block: { label: "AI review: don't post as is", cls: "border-red-500/40 bg-red-500/10 text-red-800" },
};

const VERDICT: Record<ContentReview["verdict"], string> = { ok: "looks good", caution: "check this", block: "don't post" };
const AGENT_NAME: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** The AI content reviewer's verdict on a finished clip; `onUseTitle` offers its suggested YouTube title. */
export function AiReview({ review, onUseTitle }: { review: ContentReview; onUseTitle?: (title: string) => Promise<void> }) {
  const [used, setUsed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = TONE[review.verdict];
  return (
    <div className={`space-y-1.5 rounded-lg border px-3 py-2 text-sm ${t.cls}`}>
      <p className="flex items-center gap-1.5 font-medium">
        <Bot className="size-4 shrink-0" /> {t.label}
      </p>
      {review.summary && <p className="text-pretty">{review.summary}</p>}
      {review.opinions && review.opinions.length > 1 && (
        <ul className="space-y-0.5 text-xs">
          {review.opinions.map((o) => (
            <li key={o.by}>
              <span className="font-medium">{AGENT_NAME[o.by] ?? o.by}:</span>{" "}
              {o.unavailable ? "couldn't review this one" : `${VERDICT[o.verdict]}. ${o.summary}`}
            </li>
          ))}
        </ul>
      )}
      {review.issues.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          {review.issues.map((i, k) => (
            <li key={k}>
              <span className="font-medium">{i.kind.replace(/_/g, " ")}:</span> {i.note}
            </li>
          ))}
        </ul>
      )}
      {review.title && onUseTitle && (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span>Suggested title: “{review.title}”</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-current/30 px-1.5 py-0.5 hover:bg-white/40 disabled:opacity-60"
            disabled={used}
            onClick={async () => {
              setErr(null);
              try {
                await onUseTitle(review.title!);
                setUsed(true);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            {used ? <Check className="size-3" /> : null} {used ? "Used" : "Use it"}
          </button>
        </p>
      )}
      {err && <p className="text-xs text-red-700">{err}</p>}
    </div>
  );
}
