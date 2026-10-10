"use client";
import { useEffect, useState } from "react";
import {
  AI_TASKS,
  DEFAULT_AI_ROUTING,
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
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AiRoutingSettings>(
    settings.aiRouting ?? DEFAULT_AI_ROUTING,
  );
  const [usage, setUsage] = useState<Usage>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
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
  function assign(
    task: AiTaskId,
    patch: { agent?: AgentId; model?: string; premium?: boolean },
  ) {
    const current = draft.tasks[task] ?? {
      agent: settings.agent,
      model: "",
      premium: false,
    };
    setDraft({
      ...draft,
      tasks: { ...draft.tasks, [task]: { ...current, ...patch } },
    });
    setSaved(false);
  }
  return (
    <section
      className="space-y-5 rounded-xl border bg-card p-5 shadow-sm"
      aria-labelledby="ai-routing-heading"
    >
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
            ["maxDayRequests", "Daily requests"],
            ["maxDayTokens", "Daily token allowance"],
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
        diagnostic tests. Subscription usage consumes request and token
        allowance. CLI dollar costs are unknown and retain their reserved
        allowance; SDK dollars are estimates.
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        <label>
          <input
            type="checkbox"
            checked={draft.allowCloud}
            onChange={(e) =>
              setDraft({ ...draft, allowCloud: e.target.checked })
            }
          />{" "}
          Allow cloud calls
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.allowPremiumImages}
            onChange={(e) =>
              setDraft({ ...draft, allowPremiumImages: e.target.checked })
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
              setDraft({ ...draft, retryLimit: Number(e.target.value) })
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
                    setDraft({ ...draft, tasks });
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
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <label>
                      <input
                        type="checkbox"
                        checked={Boolean(draft.tasks[task]?.escalation)}
                        onChange={(e) => {
                          const route = draft.tasks[task]!;
                          const next = { ...route };
                          if (e.target.checked)
                            next.escalation = { agent: route.agent, model: "" };
                          else delete next.escalation;
                          setDraft({
                            ...draft,
                            tasks: { ...draft.tasks, [task]: next },
                          });
                        }}
                      />{" "}
                      One escalation after failure
                    </label>
                    {draft.tasks[task]?.escalation && (
                      <>
                        <select
                          aria-label={`${task} escalation adapter`}
                          className="rounded border bg-background p-1"
                          value={draft.tasks[task]!.escalation!.agent}
                          onChange={(e) => {
                            const route = draft.tasks[task]!;
                            setDraft({
                              ...draft,
                              tasks: {
                                ...draft.tasks,
                                [task]: {
                                  ...route,
                                  escalation: {
                                    ...route.escalation!,
                                    agent: e.target.value as AgentId,
                                  },
                                },
                              },
                            });
                          }}
                        >
                          {AGENT_IDS.filter((id) => id !== "amp").map((id) => (
                            <option key={id}>{id}</option>
                          ))}
                        </select>
                        <Input
                          aria-label={`${task} escalation model`}
                          placeholder="Explicit escalation model"
                          value={draft.tasks[task]!.escalation!.model}
                          onChange={(e) => {
                            const route = draft.tasks[task]!;
                            setDraft({
                              ...draft,
                              tasks: {
                                ...draft.tasks,
                                [task]: {
                                  ...route,
                                  escalation: {
                                    ...route.escalation!,
                                    model: e.target.value,
                                  },
                                },
                              },
                            });
                          }}
                        />
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
            const valid = AiRoutingSchema.parse(draft);
            await onSave({ aiRouting: valid });
            setSaved(true);
            await refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
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
              requests · {usage.tokens.toLocaleString()} tokens ·{" "}
              {usage.pending} retained reservations
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
