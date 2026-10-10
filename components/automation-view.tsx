"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { AutomationDashboard } from "@/components/automation-dashboard";
import { CreatorPolicyForm } from "@/components/creator-policy-form";
import { SubscriptionPicker } from "@/components/subscription-picker";
import { api } from "@/hooks/use-job";
import type { AutomationHealth } from "@/lib/creator-policy";
import type { WatchedChannel, WatchFile } from "@/lib/types";
import { cn } from "@/lib/utils";

type Data = WatchFile & { checking: boolean; postingReady: boolean };

const ago = (t?: number) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1
    ? "just now"
    : m < 60
      ? `${m} min ago`
      : m < 1440
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} d ago`;
};

/** Monitor: watch YouTube channels; new uploads are clipped, checked and wait in Queue for the user's OK. */
export function AutomationView() {
  const [data, setData] = useState<Data | null>(null);
  const [health, setHealth] = useState<AutomationHealth | null>(null);
  const [input, setInput] = useState("");
  const [clipLatest, setClipLatest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, h] = await Promise.all([
        api<Data>("/api/automation"),
        api<AutomationHealth>("/api/automation/health"),
      ]);
      setData(d);
      setHealth(h);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(
      () => document.visibilityState === "visible" && void load(),
      5000,
    );
    return () => clearInterval(t);
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/automation/channels", {
        method: "POST",
        body: JSON.stringify({ input, clipLatest }),
      });
      setInput("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const reconnect = health?.accounts.filter((a) => a.needsReconnect) ?? [];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Radar className="size-6 text-primary" /> Monitor
        </h1>
        <p className="text-pretty text-sm text-muted-foreground">
          Add YouTube channels to keep an eye on. When one posts a new video,
          capy makes clips from it and puts them in{" "}
          <Link href="/queue" className="underline underline-offset-2">
            Queue
          </Link>
          . Nothing is posted until you approve it.
        </p>
      </div>

      {data && health && (
        <StatusBar data={data} health={health} onChange={load} />
      )}

      {data && !data.postingReady && (
        <Notice>
          You haven&apos;t connected an account to post to, so clips stay in
          Library instead of going to Queue.{" "}
          <Link href="/settings#accounts" className="underline underline-offset-2">
            Connect one in Settings
          </Link>
        </Notice>
      )}
      {reconnect.length > 0 && (
        <Notice>
          {reconnect.map((a) => a.platform).join(" and ")} needs you to sign in
          again.{" "}
          <Link href="/settings#accounts" className="underline underline-offset-2">
            Go to Settings
          </Link>
        </Notice>
      )}

      <form onSubmit={add} className="space-y-3 rounded-xl border bg-card p-4">
        <Label htmlFor="channel">Add a channel</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="channel"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste a channel link, @handle, or any of their videos"
            spellCheck={false}
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={clipLatest}
            onChange={(e) => setClipLatest(e.target.checked)}
          />
          Also make clips from their newest video now (otherwise only from
          videos they post later)
        </label>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </form>

      <SubscriptionPicker onImport={load} />

      {data && (
        <section className="space-y-3">
          <h2 className="font-semibold">
            Channels you&apos;re watching ({data.channels.length})
          </h2>
          {data.channels.length === 0 && (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              No channels yet. Add one above.
            </p>
          )}
          {data.channels.map((c) => (
            <ChannelCard
              key={c.id}
              c={c}
              health={health}
              onChange={load}
            />
          ))}
        </section>
      )}

      {health && <AutomationDashboard health={health} onChange={load} />}
    </div>
  );
}

/** One line answering "is it working?", with the global schedule and the buttons people actually reach for. */
function StatusBar({
  data,
  health,
  onChange,
}: {
  data: Data;
  health: AutomationHealth;
  onChange: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const stopped = health.controls.globalStop || health.controls.monitorPaused;
  const state = stopped
    ? { label: "Paused", tone: "bg-amber-500" }
    : data.checking || checking
      ? { label: "Checking now…", tone: "bg-sky-500" }
      : health.online
        ? { label: "On", tone: "bg-emerald-500" }
        : { label: "Not running", tone: "bg-muted-foreground/50" };
  const put = async (body: Record<string, unknown>) => {
    await api("/api/automation", { method: "PUT", body: JSON.stringify(body) }).catch(() => {});
    await onChange();
  };
  const togglePause = async () => {
    await api("/api/automation/health", {
      method: "PUT",
      body: JSON.stringify({
        controls: stopped
          ? { ...health.controls, monitorPaused: false, globalStop: false }
          : { ...health.controls, monitorPaused: true },
      }),
    }).catch(() => {});
    await onChange();
  };

  return (
    <section
      aria-label="Monitor status"
      className="space-y-2 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2 font-medium">
          <span className={cn("size-2.5 rounded-full", state.tone)} />
          {state.label}
        </span>
        <span className="text-sm text-muted-foreground">
          Last checked {ago(data.lastCheckAt)}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={checking || data.checking || data.channels.length === 0}
            onClick={async () => {
              setChecking(true);
              await api("/api/automation/check", { method: "POST" }).catch(() => {});
              setTimeout(() => {
                setChecking(false);
                void onChange();
              }, 1500);
            }}
          >
            {checking || data.checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}{" "}
            Check now
          </Button>
          <Button size="sm" variant="outline" onClick={() => void togglePause()}>
            {stopped ? <Play /> : <Pause />} {stopped ? "Turn on" : "Pause"}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Look for new videos every</span>
        <Select
          aria-label="How often to check"
          value={data.intervalMin}
          className="w-auto"
          onChange={(e) => void put({ intervalMin: Number(e.target.value) })}
        >
          {[15, 30, 60, 180, 360, 720, 1440].map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} min` : m === 1440 ? "day" : `${m / 60} h`}
            </option>
          ))}
        </Select>
        <span>and clip at most</span>
        <Select
          aria-label="Most videos a day, all channels"
          value={data.maxPerDay}
          className="w-auto"
          onChange={(e) => void put({ maxPerDay: Number(e.target.value) })}
        >
          {[1, 2, 4, 6, 10, 15].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <span>videos a day in total.</span>
      </div>
      <AutoSchedule />
      {!stopped && !health.online && (
        <p className="text-xs text-muted-foreground">
          capy only checks while it&apos;s open (or running in the menu bar).
        </p>
      )}
    </section>
  );
}

/** The owner's switch for scheduling clips that pass every check without waiting for approval (on by default). */
function AutoSchedule() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ settings: { autoSchedule?: boolean } }>("/api/settings")
      .then((r) => setOn(r.settings.autoSchedule ?? true))
      .catch(() => {});
  }, []);
  if (on === null) return null;
  return (
    <label className="flex items-start gap-2 border-t pt-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--primary)]"
        checked={on}
        onChange={async (e) => {
          const next = e.target.checked;
          setOn(next);
          await api("/api/settings", { method: "PUT", body: JSON.stringify({ autoSchedule: next }) }).catch(() =>
            setOn(!next),
          );
        }}
      />
      <span>
        <span className="font-medium">Schedule clips that pass every check without asking me</span>
        <span className="block text-xs text-muted-foreground">
          At least one AI says it&apos;s OK and none says don&apos;t post, it isn&apos;t a near-copy of your recent
          clips, and it has a designed thumbnail. It still waits for its time slot, so you can remove it from Queue
          before it posts. Turning this off also holds back clips it already scheduled.
        </span>
      </span>
    </label>
  );
}

function ChannelCard({
  c,
  health,
  onChange,
}: {
  c: WatchedChannel;
  health: AutomationHealth | null;
  onChange: () => Promise<void>;
}) {
  const [s, setS] = useState(c.settings);
  const [err, setErr] = useState<string | null>(null);
  const policy = health?.policies[c.id];
  const patch = async (body: Record<string, unknown>) => {
    setErr(null);
    try {
      await api(`/api/automation/channels/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setS(c.settings); // show what is actually stored
    }
    await onChange();
  };
  const setting = (
    k: keyof WatchedChannel["settings"],
    v: number | string | undefined,
  ) => {
    const next = { ...s, [k]: v };
    setS(next);
    void patch({ settings: next });
  };
  const d = c.discoveryStatus;
  const skipped = d ? d.deferred + d.excluded : 0;

  return (
    <article
      aria-label={c.name}
      className={cn("space-y-3 rounded-xl border bg-card p-4", !c.enabled && "opacity-70")}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={c.url}
            target="_blank"
            rel="noreferrer"
            className="font-semibold hover:underline"
          >
            {c.name}
          </a>
          <p className="text-xs text-muted-foreground">
            {[
              c.handle,
              `checked ${ago(c.lastCheckedAt)}`,
              c.pending.length > 0 &&
                `${c.pending.length} new video${c.pending.length === 1 ? "" : "s"} waiting their turn`,
              skipped > 0 && `${skipped} skipped`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={c.enabled}
            onChange={(e) => void patch({ enabled: e.target.checked })}
          />
          {c.enabled ? "Watching" : "Paused"}
        </label>
        <Button
          size="sm"
          variant="ghost"
          title="Stop watching"
          aria-label={`Stop watching ${c.name}`}
          onClick={async () => {
            if (
              !window.confirm(
                `Stop watching ${c.name}? Clips already made stay.`,
              )
            )
              return;
            await api(`/api/automation/channels/${c.id}`, {
              method: "DELETE",
            }).catch(() => {});
            await onChange();
          }}
        >
          <Trash2 />
        </Button>
      </div>
      {err && <p className="text-xs text-red-700">{err}</p>}
      {c.lastError && (
        <p className="flex items-center gap-1.5 text-xs text-red-700">
          <AlertTriangle className="size-3.5" /> {c.lastError}
        </p>
      )}
      {d?.method === "videos-tab" && (
        <p className="text-xs text-muted-foreground">
          capy can only see this channel&apos;s regular videos, not its Shorts
          or live replays.{" "}
          <Link href="/settings#accounts" className="underline underline-offset-2">
            Connect your YouTube account
          </Link>{" "}
          to see everything.
        </p>
      )}
      {d?.nextAttemptAt && (
        <p className="text-xs text-muted-foreground">
          Couldn&apos;t reach the channel; trying again at{" "}
          {new Date(d.nextAttemptAt).toLocaleTimeString()}.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Clips per video">
          <Select
            value={s.clips}
            onChange={(e) => setting("clips", Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 8].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Skip videos shorter than">
          <Select
            value={s.minVideoSec}
            onChange={(e) => setting("minVideoSec", Number(e.target.value))}
          >
            {[120, 240, 480, 900].map((v) => (
              <option key={v} value={v}>
                {v / 60} min
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Most videos a day">
          <Select
            value={s.perDay}
            onChange={(e) => setting("perDay", Number(e.target.value))}
          >
            {[1, 2, 3, 5].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Caption language">
          <Select
            value={s.audience ?? ""}
            onChange={(e) => setting("audience", e.target.value || undefined)}
          >
            <option value="">Use my default</option>
            <option value="en-us">English (US)</option>
            <option value="original">Same as the video</option>
          </Select>
        </Field>
      </div>
      {c.history.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Recent videos</p>
          <ul className="space-y-1 text-sm">
            {c.history.slice(0, 5).map((h) => (
              <li
                key={h.jobId + h.at}
                className="flex flex-wrap items-center gap-2"
              >
                {h.status === "processing" ? (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                ) : h.status === "rendered" ? (
                  <CheckCircle2 className="size-3.5 text-emerald-600" />
                ) : (
                  <AlertTriangle className="size-3.5 text-red-600" />
                )}
                <Link
                  href={`/v/${h.jobId}`}
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  {h.title}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {h.status === "processing"
                    ? "making clips…"
                    : h.status === "rendered"
                      ? (h.note ?? "clips ready in Queue")
                      : h.error}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {policy && health && (
        <CreatorPolicyForm
          // remount when the card's own fields change the saved options
          key={`${policy.recipeId ?? "initial"}:${policy.clips}:${policy.minDurationSec}`}
          channelId={c.id}
          policy={policy}
          accounts={health.accounts}
          onSaved={() => void onChange()}
        />
      )}
    </article>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
