"use client";
import { useState } from "react";
import type {
  AutomationHealth,
  AutomationControls,
} from "@/lib/creator-policy";
import { api } from "@/hooks/use-job";
import { Button } from "./ui/button";
const date = (at?: number) => (at ? new Date(at).toLocaleString() : "Never");

/** The background helper's details, folded away: most people never need this, but it's where to look when nothing happens. */
export function AutomationDashboard({
  health,
  onChange,
}: {
  health: AutomationHealth;
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const control = async (key: keyof AutomationControls) => {
    try {
      await api<AutomationHealth>("/api/automation/health", {
        method: "PUT",
        body: JSON.stringify({
          controls: { ...health.controls, [key]: !health.controls[key] },
        }),
      });
      setError("");
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <details className="group rounded-xl border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        <span>Behind the scenes</span>
        <span className="ml-2 font-normal text-muted-foreground">
          {health.online ? "running" : "not running"}
          {health.reasons.length > 0 &&
            ` · ${health.reasons.length} skipped or stuck`}
        </span>
      </summary>
      <section
        aria-label="Behind the scenes"
        className="space-y-4 border-t px-4 py-4"
      >
        <p className="text-xs text-muted-foreground">
          A helper runs in the background to check channels, make clips and
          post. Look here if nothing seems to be happening.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          {[
            ["Helper", health.online ? "Running" : "Not running"],
            [
              "Doing now",
              health.activeStage ?? (health.online ? "Nothing" : "—"),
            ],
            ["Last sign of life", date(health.heartbeat)],
            ["Last finished task", date(health.lastSuccessAt)],
            ["Tasks waiting", health.pending],
            ["Oldest waiting task", date(health.oldestPendingAt)],
            ["Next post", date(health.nextPostAt)],
            [
              "Free disk space",
              health.disk.availableBytes === undefined
                ? "Unknown"
                : `${(health.disk.availableBytes / 1024 ** 3).toFixed(1)} GB`,
            ],
            [
              "AI spend today",
              `$${health.budget.reservedUsd.toFixed(2)} of $${health.budget.maxDayUsd.toFixed(2)}`,
            ],
            [
              "AI requests today",
              `${health.budget.requests} of ${health.budget.maxDayRequests}`,
            ],
          ].map(([label, text]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        {health.disk.error && (
          <p className="text-xs text-red-600">
            Couldn&apos;t read disk space: {health.disk.error}
          </p>
        )}
        {health.budget.unknown > 0 && (
          <p className="text-xs text-muted-foreground">
            {health.budget.unknown} AI runs didn&apos;t report their cost, so
            their share of today&apos;s budget stays held.
          </p>
        )}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Pause one step at a time. Anything already running finishes first.
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["monitorPaused", "checking channels"],
                ["renderPaused", "making clips"],
                ["postPaused", "posting"],
                ["globalStop", "everything"],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                variant={health.controls[key] ? "default" : "outline"}
                size="sm"
                onClick={() => void control(key)}
              >
                {health.controls[key] ? "Resume" : "Pause"} {label}
              </Button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Clips that pass every check are scheduled on their own while that
          switch is on; everything else waits in Queue for your OK. Nothing
          posts before its time slot.
        </p>
        <div className="text-xs">
          {health.accounts.map((a) => (
            <p key={a.platform}>
              {a.platform}:{" "}
              {a.needsReconnect
                ? "needs you to sign in again"
                : a.connected
                  ? `connected${a.id ? ` (${a.id})` : ""}`
                  : "not connected"}
            </p>
          ))}
        </div>
        <details>
          <summary className="cursor-pointer text-sm">
            Skipped videos and problems ({health.reasons.length})
          </summary>
          <ul className="mt-2 space-y-2 text-sm">
            {health.reasons.map((r, i) => (
              <li key={`${r.id}:${i}`}>
                <span className="font-medium">
                  {health.creatorNames[r.id] ?? r.id}
                </span>{" "}
                · {r.reason}
              </li>
            ))}
          </ul>
          {!health.reasons.length && (
            <p className="text-xs text-muted-foreground">Nothing skipped.</p>
          )}
        </details>
      </section>
    </details>
  );
}
