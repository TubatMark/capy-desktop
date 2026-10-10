"use client";
import { AiRoutingSettings } from "./ai-routing-settings";
import { useState } from "react";
import {
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/hooks/use-job";
import { cn } from "@/lib/utils";
import type { AgentId, AgentInfo, AppSettings } from "@/lib/types";

type TestResult = { ok: boolean; ms: number; error?: string };

export function SettingsView({
  initialSettings,
  initialAgents,
}: {
  initialSettings: AppSettings;
  initialAgents: AgentInfo[];
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [agents, setAgents] = useState(initialAgents);
  const [scanning, setScanning] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tests, setTests] = useState<
    Partial<Record<AgentId, TestResult | "running">>
  >({});

  const installed = agents.filter((a) => a.installed);
  const missing = agents.filter((a) => !a.installed);
  const current = agents.find((a) => a.id === settings.agent);

  async function save(patch: Partial<AppSettings>) {
    setErr(null);
    const prev = settings;
    setSettings({
      ...settings,
      ...patch,
      models: { ...settings.models, ...patch.models },
    });
    try {
      const r = await api<{ settings: AppSettings }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      setSettings(r.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setSettings(prev);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function rescan() {
    setScanning(true);
    try {
      const r = await api<{ agents: AgentInfo[] }>("/api/settings?rescan=1");
      setAgents(r.agents);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  async function test(id: AgentId) {
    setTests((t) => ({ ...t, [id]: "running" }));
    try {
      const r = await api<TestResult>("/api/settings/test", {
        method: "POST",
        body: JSON.stringify({ agent: id, model: settings.models[id] }),
      });
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [id]: {
          ok: false,
          ms: 0,
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Preferences for this Mac. They apply to every video.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">AI</h2>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              The AI that picks clips and writes titles, hooks and descriptions.
              capy found {installed.length} on this Mac.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={rescan}
              disabled={scanning}
            >
              <RefreshCw className={cn(scanning && "animate-spin")} />
              Rescan
            </Button>
            <span
              aria-live="polite"
              className={cn(
                "flex items-center gap-1 text-xs text-muted-foreground transition-opacity",
                saved ? "opacity-100" : "opacity-0",
              )}
            >
              <Check className="size-3.5" /> Saved
            </span>
          </div>
        </div>

        {err && <p className="mt-3 text-sm text-red-500">{err}</p>}

        <div
          role="radiogroup"
          aria-label="AI to use"
          className="mt-5 grid grid-cols-1 gap-2"
        >
          {installed.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              selected={a.id === settings.agent}
              onSelect={() => a.id !== settings.agent && save({ agent: a.id })}
            />
          ))}
        </div>

        {current && (
          <div className="mt-5 space-y-3 border-t pt-5">
            <div className="grid gap-1.5">
              <Label htmlFor="model">{current.name} model</Label>
              <div className="flex gap-2">
                <Input
                  id="model"
                  key={current.id}
                  defaultValue={settings.models[current.id] ?? ""}
                  placeholder={
                    current.modelHint
                      ? `Default (e.g. ${current.modelHint})`
                      : "Default"
                  }
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== (settings.models[current.id] ?? ""))
                      save({ models: { [current.id]: v } });
                  }}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  onClick={() => test(current.id)}
                  disabled={tests[current.id] === "running"}
                >
                  {tests[current.id] === "running" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Zap />
                  )}
                  Test
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Leave empty to use the{" "}
                {current.id === "claude"
                  ? "task routing defaults"
                  : "CLI's own default"}
                .
              </p>
            </div>
            <TestLine result={tests[current.id]} name={current.name} />
          </div>
        )}
      </section>

      <AiRoutingSettings
        settings={settings}
        onSave={async (patch) => {
          const result = await api<{ settings: AppSettings }>("/api/settings", {
            method: "PUT",
            body: JSON.stringify(patch),
          });
          setSettings(result.settings);
        }}
      />

      {missing.length > 0 && (
        <section className="rounded-xl border bg-card p-5 shadow-sm">
          <h2 className="font-semibold">Not installed</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            capy also works with these. Install one, then press Rescan.
          </p>
          <ul className="mt-4 divide-y">
            {missing.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
              >
                <AgentMark agent={a} muted />
                <div className="min-w-0 flex-1">
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                  >
                    {a.name}{" "}
                    <ExternalLink className="size-3 text-muted-foreground" />
                  </a>
                  <p className="text-xs text-muted-foreground">{a.vendor}</p>
                </div>
                <CopyCommand cmd={a.install} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AgentRow({
  agent: a,
  selected,
  onSelect,
}: {
  agent: AgentInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-4 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/10" : "hover:bg-accent",
      )}
    >
      <AgentMark agent={a} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {a.name}
          {a.id === "claude" && (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
              Default
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {a.vendor}
          {a.version ? ` · v${a.version}` : ""}
          {a.path
            ? ` · ${a.path.replace(/^\/Users\/[^/]+/, "~")}`
            : a.id === "claude"
              ? " · built in"
              : ""}
        </p>
      </div>
      <span
        aria-hidden
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full border",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input",
        )}
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

function AgentMark({
  agent,
  muted = false,
}: {
  agent: AgentInfo;
  muted?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-md border font-mono text-sm font-semibold",
        muted ? "bg-muted text-muted-foreground" : "bg-background",
      )}
    >
      {agent.name.slice(0, 2)}
    </span>
  );
}

function TestLine({
  result,
  name,
}: {
  result: TestResult | "running" | undefined;
  name: string;
}) {
  if (!result) return null;
  if (result === "running")
    return <p className="text-sm text-muted-foreground">Asking {name}…</p>;
  if (result.ok)
    return (
      <p className="flex items-center gap-1.5 text-sm text-emerald-600">
        <Check className="size-4" /> {name} answered in{" "}
        {(result.ms / 1000).toFixed(1)}s
      </p>
    );
  return (
    <p className="flex items-start gap-1.5 text-sm text-red-600">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="break-words">{result.error}</span>
    </p>
  );
}

function CopyCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(cmd).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="flex max-w-full items-center gap-2 rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground hover:text-foreground"
      title="Copy install command"
    >
      <span className="truncate">{cmd}</span>
      {copied ? (
        <Check className="size-3.5 shrink-0" />
      ) : (
        <Copy className="size-3.5 shrink-0" />
      )}
    </button>
  );
}
