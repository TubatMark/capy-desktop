"use client";
import { useEffect, useState } from "react";
import {
  AI_TASKS,
  DEFAULT_AI_ROUTING,
  defaultAiModel,
  type AiRoutingSettings,
  type AiTaskId,
} from "@/lib/ai-policy";
import { AGENT_IDS, type AppSettings, type AgentId } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { api } from "@/hooks/use-job";

type Usage = {
  day: string;
  usd: number;
  requests: number;
  tokens: number;
  pending: number;
  reportedTokens: number;
  unknownUsageRuns: number;
  tasks: {
    task: string;
    calls: number;
    cached: number;
    estimatedUsd: number;
    unknown: number;
  }[];
};
export function AiRoutingSettings({
  settings,
  onSave,
}: {
  settings: AppSettings;
  onSave: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}) {
  const [draft, setDraft] = useState<AiRoutingSettings>(
    settings.aiRouting ?? DEFAULT_AI_ROUTING,
  );
  const [usage, setUsage] = useState<Usage>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingEscalations, setPendingEscalations] = useState<
    Partial<Record<AiTaskId, { agent: AgentId; model: string }>>
  >({});
  useEffect(() => {
    setDraft(settings.aiRouting ?? DEFAULT_AI_ROUTING);
  }, [settings.aiRouting]);
  async function refresh() {
    try {
      const response = await api<{ aiUsage: Usage }>("/api/settings");
      setUsage(response.aiUsage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  function editDraft(next: AiRoutingSettings) {
    setDraft(next);
    setSaved(false);
  }
  function assign(
    task: AiTaskId,
    patch: { agent?: AgentId; model?: string; premium?: boolean },
  ) {
    const current = draft.tasks[task] ?? {
      agent: settings.agent,
      model: defaultAiModel(task, patch.agent ?? settings.agent),
      premium: false,
    };
    const next = { ...current, ...patch };
    if (patch.agent && patch.agent !== current.agent)
      next.model = defaultAiModel(task, patch.agent);
    if (!next.model?.trim()) delete next.model;
    setDraft({ ...draft, tasks: { ...draft.tasks, [task]: next } });
    setSaved(false);
  }
  return (
    <section
      className="space-y-5 rounded-xl border bg-card p-5 shadow-sm"
      aria-labelledby="ai-routing-heading"
    >
      {settings.aiRoutingError && (
        <p role="alert" className="text-sm text-red-600">
          {settings.aiRoutingError}
        </p>
      )}
      <p
        data-testid="ai-active-policy"
        className="text-xs text-muted-foreground"
      >
        Last confirmed policy: cloud calls{" "}
        {settings.aiRouting?.allowCloud === false ? "disabled" : "allowed"};
        daily USD allowance $
        {(
          settings.aiRouting?.maxDayUsd ?? DEFAULT_AI_ROUTING.maxDayUsd
        ).toFixed(2)}
        .
      </p>
      <div>
        <h2 id="ai-routing-heading" className="font-semibold">
          AI task routing and limits
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Titles, translation and review use compact candidates; clip selection
          uses a mid-tier candidate. Model access and quality need evaluation.
          Technical edits and thumbnail text run locally.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["maxJobUsd", "Per-job reserved USD"],
            ["maxDayUsd", "Daily reserved USD"],
            ["maxDayRequests", "Daily application admission units"],
            ["maxDayTokens", "Daily token allowance (reserved or reported)"],
          ] as const
        ).map(([key, title]) => (
          <label key={key} className="grid gap-1 text-sm">
            {title}
            <Input
              type="number"
              min="0"
              step={key.endsWith("Usd") ? "0.1" : "1"}
              value={draft[key]}
              onChange={(e) => {
                setDraft({ ...draft, [key]: Number(e.target.value) });
                setSaved(false);
              }}
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Limits include retries, configured escalation, Stories and explicit
        diagnostics. Application admission bounds run/turn allowances and
        reserves token allowance; provider-internal requests and tokens can
        exceed that allowance. Unknown CLI costs retain their USD allowance; SDK
        dollars are estimates, not invoice caps.
      </p>
      <label className="grid gap-1 text-sm">
        Usage limit mode
        <select
          aria-label="AI usage limit mode"
          className="rounded border bg-background p-2"
          value={draft.usageLimitMode}
          onChange={(e) => {
            setDraft({
              ...draft,
              usageLimitMode: e.target
                .value as AiRoutingSettings["usageLimitMode"],
            });
            setSaved(false);
          }}
        >
          <option value="application">Application admission (default)</option>
          <option value="provider">Strict provider quotas</option>
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        {draft.usageLimitMode === "provider"
          ? "Strict mode requires verified provider session bounds. Current adapters cannot establish those bounds and model calls are blocked."
          : "Application admission keeps the assisted workflow available. Actual provider request counts are unknown; only reported token receipts are measured."}
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        <label>
          <input
            type="checkbox"
            checked={draft.allowCloud}
            onChange={(e) =>
              editDraft({ ...draft, allowCloud: e.target.checked })
            }
          />{" "}
          Allow cloud calls
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.allowPremiumImages}
            onChange={(e) =>
              editDraft({ ...draft, allowPremiumImages: e.target.checked })
            }
          />{" "}
          Allow premium image quality
        </label>
        <label>
          Retries{" "}
          <select
            aria-label="AI retry ceiling"
            value={draft.retryLimit}
            onChange={(e) =>
              editDraft({ ...draft, retryLimit: Number(e.target.value) })
            }
          >
            <option value="0">0</option>
            <option value="1">1</option>
          </select>
        </label>
      </div>
      <div className="space-y-3">
        {AI_TASKS.map((task) => (
          <div key={task} className="rounded-md border p-3">
            <div className="flex justify-between gap-2">
              <span className="text-sm font-medium">
                {task.replaceAll("-", " ")}
              </span>
              {draft.tasks[task] && (
                <button
                  className="text-xs underline"
                  type="button"
                  onClick={() => {
                    const tasks = { ...draft.tasks };
                    delete tasks[task];
                    editDraft({ ...draft, tasks });
                  }}
                >
                  Use economical default
                </button>
              )}
            </div>
            {["vision", "thumbnail-generation"].includes(task) ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Unavailable: current prompt adapters transport text only. Local
                thumbnails remain available.
              </p>
            ) : task === "transcription" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Captions first, then local Whisper; no cloud call.
              </p>
            ) : (
              <>
                <div className="mt-2 flex gap-2">
                  <select
                    aria-label={`${task} adapter`}
                    className="rounded border bg-background p-1 text-sm"
                    value={draft.tasks[task]?.agent ?? settings.agent}
                    onChange={(e) =>
                      assign(task, { agent: e.target.value as AgentId })
                    }
                  >
                    {AGENT_IDS.filter((id) => id !== "amp").map((id) => (
                      <option key={id}>{id}</option>
                    ))}
                  </select>
                  <Input
                    aria-label={`${task} model`}
                    placeholder={
                      task === "selection"
                        ? "Default mid-tier candidate"
                        : "Default compact candidate"
                    }
                    value={draft.tasks[task]?.model ?? ""}
                    onChange={(e) => assign(task, { model: e.target.value })}
                  />
                </div>
                <label className="mt-2 block text-xs">
                  <input
                    type="checkbox"
                    checked={draft.tasks[task]?.premium ?? false}
                    onChange={(e) =>
                      assign(task, { premium: e.target.checked })
                    }
                  />{" "}
                  Explicitly allow premium for this task
                </label>
                {draft.tasks[task] && (
                  <div className="mt-2 space-y-2 text-xs">
                    {draft.tasks[task]?.escalation ? (
                      <>
                        <p>
                          One explicit escalation:{" "}
                          {draft.tasks[task]!.escalation!.agent} /{" "}
                          {draft.tasks[task]!.escalation!.model}
                        </p>
                        <button
                          type="button"
                          className="underline"
                          onClick={() => {
                            const route = { ...draft.tasks[task]! };
                            delete route.escalation;
                            setDraft({
                              ...draft,
                              tasks: { ...draft.tasks, [task]: route },
                            });
                            setSaved(false);
                          }}
                        >
                          Remove escalation
                        </button>
                      </>
                    ) : (
                      <>
                        <label className="block">
                          Optional escalation model
                        </label>
                        <div className="flex gap-2">
                          <select
                            aria-label={`${task} escalation adapter`}
                            className="rounded border bg-background p-1"
                            value={
                              pendingEscalations[task]?.agent ??
                              draft.tasks[task]!.agent
                            }
                            onChange={(e) =>
                              setPendingEscalations({
                                ...pendingEscalations,
                                [task]: {
                                  model: pendingEscalations[task]?.model ?? "",
                                  agent: e.target.value as AgentId,
                                },
                              })
                            }
                          >
                            {AGENT_IDS.filter((id) => id !== "amp").map(
                              (id) => (
                                <option key={id}>{id}</option>
                              ),
                            )}
                          </select>
                          <Input
                            aria-label={`${task} escalation model`}
                            placeholder="Choose a model before enabling escalation"
                            value={pendingEscalations[task]?.model ?? ""}
                            onChange={(e) =>
                              setPendingEscalations({
                                ...pendingEscalations,
                                [task]: {
                                  agent:
                                    pendingEscalations[task]?.agent ??
                                    draft.tasks[task]!.agent,
                                  model: e.target.value,
                                },
                              })
                            }
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Enable ${task} escalation`}
                            disabled={!pendingEscalations[task]?.model.trim()}
                            onClick={() => {
                              const pending = pendingEscalations[task]!;
                              setDraft({
                                ...draft,
                                tasks: {
                                  ...draft.tasks,
                                  [task]: {
                                    ...draft.tasks[task]!,
                                    escalation: {
                                      agent: pending.agent,
                                      model: pending.model.trim(),
                                    },
                                  },
                                },
                              });
                              setSaved(false);
                            }}
                          >
                            Enable
                          </Button>
                        </div>
                        <p className="text-muted-foreground">
                          Escalation stays off until a model is chosen and
                          enabled.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <Button
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          setError(undefined);
          setSaved(false);
          try {
            const { AiRoutingSchema } = await import("@/lib/ai-policy");
            const parsed = AiRoutingSchema.safeParse(draft);
            if (!parsed.success) {
              const issue = parsed.error.issues[0];
              throw new Error(
                `${issue?.path.join(".") ?? "AI policy"}: ${issue?.message ?? "invalid settings"}`,
              );
            }
            const persisted = await onSave({ aiRouting: parsed.data });
            if (!persisted.aiRouting)
              throw new Error("Server did not confirm the saved AI policy");
            setDraft(persisted.aiRouting);
            setSaved(true);
            await refresh();
          } catch (e) {
            setDraft(settings.aiRouting ?? DEFAULT_AI_ROUTING);
            setError(
              `Save failed: ${e instanceof Error ? e.message : String(e)}. The last confirmed policy remains shown above.`,
            );
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "Saving…" : "Save AI routing"}
      </Button>
      {saved && (
        <span role="status" className="ml-3 text-sm">
          Saved
        </span>
      )}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Today’s usage (UTC)</h3>
          <button type="button" className="text-xs underline" onClick={refresh}>
            Refresh
          </button>
        </div>
        {usage ? (
          <>
            <p className="mt-2 text-xs text-muted-foreground">
              Reserved or settled ${usage.usd.toFixed(2)} · {usage.requests}{" "}
              application admission units · {usage.tokens.toLocaleString()}{" "}
              reserved/reported token allowance · {usage.pending} retained
              reservations
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Actual provider requests: unknown. Reported query-pipeline tokens:{" "}
              {usage.reportedTokens.toLocaleString()}. Runs without token
              receipts: {usage.unknownUsageRuns}.
            </p>
            <table className="mt-3 w-full text-left text-xs">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Calls / cache</th>
                  <th>Estimate USD</th>
                  <th>Unknown receipts</th>
                </tr>
              </thead>
              <tbody>
                {usage.tasks.map((task) => (
                  <tr key={task.task}>
                    <td className="py-2">{task.task}</td>
                    <td>
                      {task.calls} / {task.cached}
                    </td>
                    <td>${task.estimatedUsd.toFixed(3)}</td>
                    <td>{task.unknown}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!usage.tasks.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                No model runs recorded today.
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Usage is loading.
          </p>
        )}
      </div>
    </section>
  );
}
