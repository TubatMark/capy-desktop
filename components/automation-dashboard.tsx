"use client";
import { useCallback, useEffect, useState } from "react";
import type {
  AutomationHealth,
  AutomationControls,
} from "@/lib/creator-policy";
import { api } from "@/hooks/use-job";
import { Button } from "./ui/button";
import { CreatorPolicyForm } from "./creator-policy-form";
const date = (at?: number) => (at ? new Date(at).toLocaleString() : "Never");
export function AutomationDashboard() {
  const [health, setHealth] = useState<AutomationHealth | null>(null),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setHealth(await api<AutomationHealth>("/api/automation/health"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const control = async (key: keyof AutomationControls) => {
    if (!health) return;
    try {
      setHealth(
        await api<AutomationHealth>("/api/automation/health", {
          method: "PUT",
          body: JSON.stringify({
            controls: { ...health.controls, [key]: !health.controls[key] },
          }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section
      aria-label="Automation operations"
      className="space-y-4 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Worker and automation</h2>
        <span className="text-sm" data-testid="worker-status">
          {health?.online ? "Worker online" : "Worker offline"}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {!health ? (
        <p className="text-sm text-muted-foreground">
          Loading persisted worker status…
        </p>
      ) : (
        <>
          {!health.online && (
            <p className="text-sm text-muted-foreground">
              The worker is offline. Work waits while this Mac is asleep or the
              worker is stopped.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            {[
              ["Heartbeat", date(health.heartbeat)],
              [
                "Current stage",
                health.activeStage ?? (health.online ? "Idle" : "Offline"),
              ],
              ["Last successful work", date(health.lastSuccessAt)],
              ["Oldest pending", date(health.oldestPendingAt)],
              ["Next post", date(health.nextPostAt)],
              ["Pending work", health.pending],
              [
                "Disk available",
                health.disk.availableBytes === undefined
                  ? "Unavailable"
                  : `${(health.disk.availableBytes / 1024 ** 3).toFixed(1)} GB`,
              ],
              [
                "AI budget",
                `$${health.budget.reservedUsd.toFixed(2)} reserved / $${health.budget.maxDayUsd.toFixed(2)} daily`,
              ],
              [
                "AI request allowance",
                `${health.budget.requests} / ${health.budget.maxDayRequests}`,
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
              Disk status: {health.disk.error}
            </p>
          )}
          {health.budget.unknown > 0 && (
            <p className="text-xs text-muted-foreground">
              {health.budget.unknown} AI runs have unknown usage. Reserved
              allowance is retained.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["monitorPaused", "monitoring"],
                ["renderPaused", "rendering"],
                ["postPaused", "posting"],
                ["globalStop", "all future work"],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                variant={health.controls[key] ? "default" : "outline"}
                size="sm"
                onClick={() => void control(key)}
              >
                {health.controls[key] ? "Resume" : "Stop"} {label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Controls prevent future worker stages. An already running external
            operation keeps its existing cancellation and recovery rules.
          </p>
          <p className="text-xs text-muted-foreground">
            {health.publication.reason}.
          </p>
          <div className="text-xs">
            {health.accounts.map((a) => (
              <p key={a.platform}>
                {a.platform}:{" "}
                {a.needsReconnect
                  ? "Reconnect required"
                  : a.connected
                    ? `Connected ${a.id ?? ""}`
                    : "Disconnected"}
              </p>
            ))}
          </div>
          <details>
            <summary className="cursor-pointer text-sm">
              Deferred work and exceptions ({health.reasons.length})
            </summary>
            <ul className="mt-2 space-y-2 text-sm">
              {health.reasons.map((r, i) => (
                <li key={`${r.id}:${i}`}>
                  <span className="font-medium">{r.id}</span> · {r.reason}
                </li>
              ))}
            </ul>
            {!health.reasons.length && (
              <p className="text-xs text-muted-foreground">
                No saved exceptions.
              </p>
            )}
          </details>
          {Object.entries(health.policies).map(([id, policy]) => (
            <div key={`${id}:${policy.recipeId ?? "initial"}`}>
              <p className="mb-2 text-sm font-medium">
                {health.creatorNames[id] ?? id}
              </p>
              <CreatorPolicyForm
                channelId={id}
                policy={policy}
                accounts={health.accounts}
                onSaved={() => void refresh()}
              />
            </div>
          ))}
        </>
      )}
    </section>
  );
}
