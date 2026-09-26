"use client";
import { useEffect, useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { fmtRemaining } from "@/lib/utils";
import type { JobState, Stage } from "@/lib/types";

const STAGES: { key: Stage; label: string }[] = [
  { key: "meta", label: "Video info" },
  { key: "captions", label: "Transcript" },
  { key: "pick", label: "AI picks moments" },
  { key: "segments", label: "Downloading clips" },
];

/** Stepper + countdown shown while a job is analyzing/preparing. */
export function StageProgress({ job }: { job: JobState }) {
  const running = job.status === "analyzing" || job.status === "preparing";
  const idx = STAGES.findIndex((s) => s.key === job.stage);
  const current = idx >= 0 ? idx : STAGES.length;
  const lastLog = job.log[job.log.length - 1];

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-medium">
            {job.status === "error" ? "Something went wrong" : running ? STAGES[current]?.label ?? "Finishing" : "Ready to review"}
            {running && job.startedAt ? <span className="ml-2 font-mono text-xs font-normal text-muted-foreground"><Elapsed since={job.startedAt} /></span> : null}
          </p>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{job.status === "error" ? job.error : lastLog?.msg ?? "Starting…"}</p>
        </div>
        {running && (
          <div className="shrink-0 text-right">
            <p className="font-mono text-2xl tabular-nums">{fmtRemaining(job.estimate.totalRemaining)}</p>
            <p className="text-xs text-muted-foreground">until picks are ready</p>
          </div>
        )}
      </div>
      <Progress value={job.status === "error" ? 0 : running ? job.estimate.progress : 1} className="mt-4" />
      <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STAGES.map((s, i) => {
          const state = job.status === "error" && i === current ? "error" : i < current || !running ? "done" : i === current ? "active" : "todo";
          return (
            <li key={s.key} className="flex items-center gap-2 text-sm">
              <span
                className={
                  "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] " +
                  (state === "done"
                    ? "border-primary bg-primary text-primary-foreground"
                    : state === "active"
                      ? "border-primary text-primary"
                      : state === "error"
                        ? "border-red-500 text-red-600"
                        : "border-border text-muted-foreground")
                }
              >
                {state === "done" ? <Check className="size-3" strokeWidth={3} /> : state === "active" ? <Loader2 className="size-3 animate-spin" /> : state === "error" ? <AlertCircle className="size-3" /> : i + 1}
              </span>
              <span className={state === "todo" ? "text-muted-foreground" : ""}>{s.label}</span>
              {state === "active" && job.estimate.stageRemaining > 0 && <span className="ml-auto font-mono text-xs text-muted-foreground">{fmtRemaining(job.estimate.stageRemaining)}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Live "elapsed" counter so the user sees time passing even between server updates. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - since) / 1000));
  return <>{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`} elapsed</>;
}
