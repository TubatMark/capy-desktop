"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  Radar,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { SubscriptionPicker } from "@/components/subscription-picker";
import { api } from "@/hooks/use-job";
import type { WatchedChannel, WatchFile } from "@/lib/types";

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

/** Creator automation: watch channels; new uploads are clipped, AI-reviewed and wait in Queue for the user's OK. */
export function AutomationView() {
  const [data, setData] = useState<Data | null>(null);
  const [input, setInput] = useState("");
  const [clipLatest, setClipLatest] = useState(false);
  const [busy, setBusy] = useState<"add" | "check" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Data>("/api/automation"));
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
    setBusy("add");
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
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Radar className="size-6 text-primary" /> Automation
        </h1>
        <p className="text-pretty text-sm text-muted-foreground">
          Watch YouTube creators. When one uploads, capy picks the best moments,
          an AI reviewer checks them, the passing clips are rendered and checked
          again, and they wait in{" "}
          <Link href="/queue" className="underline underline-offset-2">
            Queue
          </Link>{" "}
          for your OK. Nothing is posted until you approve it.
        </p>
      </div>

      <SubscriptionPicker onImport={load} />

      <form onSubmit={add} className="space-y-3 rounded-xl border bg-card p-4">
        <Label htmlFor="channel">Watch a creator</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="channel"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="@handle, channel link, or any video of theirs"
            spellCheck={false}
          />
          <Button type="submit" disabled={busy !== null || !input.trim()}>
            {busy === "add" ? <Loader2 className="animate-spin" /> : <Plus />}{" "}
            Watch
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={clipLatest}
            onChange={(e) => setClipLatest(e.target.checked)}
          />
          Also clip their latest upload now (otherwise only uploads from now on)
        </label>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </form>

      {data && !data.postingReady && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
          No posting account is connected, so automation&apos;s clips stay on
          each video&apos;s page instead of waiting in Queue.{" "}
          <Link
            href="/settings#accounts"
            className="underline underline-offset-2"
          >
            Connect an account
          </Link>
        </p>
      )}

      {data && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">
              Watching {data.channels.filter((c) => c.enabled).length} creator
              {data.channels.filter((c) => c.enabled).length === 1 ? "" : "s"}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Check every</span>
              <Select
                value={data.intervalMin}
                className="w-auto"
                onChange={async (e) => {
                  await api("/api/automation", {
                    method: "PUT",
                    body: JSON.stringify({
                      intervalMin: Number(e.target.value),
                    }),
                  }).catch(() => {});
                  void load();
                }}
              >
                {[15, 30, 60, 180, 360, 720, 1440].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} min` : m === 1440 ? "day" : `${m / 60} h`}
                  </option>
                ))}
              </Select>
              <span>· up to</span>
              <Select
                value={data.maxPerDay}
                className="w-auto"
                onChange={async (e) => {
                  await api("/api/automation", {
                    method: "PUT",
                    body: JSON.stringify({ maxPerDay: Number(e.target.value) }),
                  }).catch(() => {});
                  void load();
                }}
              >
                {[1, 2, 4, 6, 10, 15].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
              <span>videos a day</span>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy !== null || data.checking || data.channels.length === 0
                }
                onClick={async () => {
                  setBusy("check");
                  await api("/api/automation/check", { method: "POST" }).catch(
                    () => {},
                  );
                  setTimeout(() => {
                    setBusy(null);
                    void load();
                  }, 1500);
                }}
              >
                {data.checking || busy === "check" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}{" "}
                Check now
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Last check: {ago(data.lastCheckAt)}. Checks run while capy is open
            or in the menu bar.
          </p>
          {data.channels.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Not watching anyone yet.
            </p>
          )}
          {data.channels.map((c) => (
            <ChannelCard key={c.id} c={c} onChange={load} />
          ))}
        </section>
      )}
    </div>
  );
}

function ChannelCard({
  c,
  onChange,
}: {
  c: WatchedChannel;
  onChange: () => Promise<void>;
}) {
  const [s, setS] = useState(c.settings);
  const [err, setErr] = useState<string | null>(null);
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

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
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
            {c.handle ?? c.id} · checked {ago(c.lastCheckedAt)}
            {c.pending.length > 0 &&
              ` · ${c.pending.length} new upload${c.pending.length === 1 ? "" : "s"} waiting`}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={c.enabled}
            onChange={(e) => void patch({ enabled: e.target.checked })}
          />
          On
        </label>
        <Button
          size="sm"
          variant="ghost"
          title="Stop watching"
          onClick={async () => {
            if (
              !window.confirm(
                `Stop watching ${c.name}? Videos already clipped stay.`,
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
        <Field label="Skip videos under">
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
        <Field label="Videos per day">
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
        <Field label="Audience">
          <Select
            value={s.audience ?? ""}
            onChange={(e) => setting("audience", e.target.value || undefined)}
          >
            <option value="">Settings default</option>
            <option value="en-us">English (US)</option>
            <option value="original">Same as the video</option>
          </Select>
        </Field>
      </div>
      {c.history.length > 0 && (
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
                  ? "clipping…"
                  : h.status === "rendered"
                    ? (h.note ?? "clips in Queue")
                    : h.error}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
