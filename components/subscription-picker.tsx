"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/hooks/use-job";
import type {
  AccountPublic,
  CreatorImport,
  ImportCreatorsResult,
  SubscriptionChannel,
  SubscriptionPage,
} from "@/lib/types";

/** Select from the reading principal's subscriptions, independently of publishing destinations. */
export function SubscriptionPicker({
  onImport,
}: {
  onImport: () => Promise<void>;
}) {
  const [account, setAccount] = useState<AccountPublic | null>(null);
  const [channels, setChannels] = useState<SubscriptionChannel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string>();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<CreatorImport["mode"]>("manual");
  const [backfill, setBackfill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reconnect, setReconnect] = useState(false);
  const [saved, setSaved] = useState<string>();
  const generation = useRef(0);
  useEffect(() => {
    void api<AccountPublic>("/api/accounts?role=reading")
      .then(setAccount)
      .catch((e) => setError(e.message));
    return () => {
      generation.current++;
    };
  }, []);

  async function load(refresh: boolean) {
    const current = ++generation.current;
    setBusy(true);
    setError(undefined);
    setSaved(undefined);
    try {
      const reading = await api<AccountPublic>("/api/accounts?role=reading");
      if (current !== generation.current) return;
      setAccount(reading);
      const changed = reading.account?.id !== account?.account?.id;
      if (refresh || changed) {
        setChannels([]);
        setSelected(new Set());
        setCursor(undefined);
      }
      if (!reading.connected || !reading.account?.id) {
        setReconnect(true);
        throw new Error(
          "Connect your YouTube account in Settings first",
        );
      }
      const params = new URLSearchParams({ accountId: reading.account.id });
      if (!refresh && !changed && cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/subscriptions?${params}`);
      const page = (await response.json()) as SubscriptionPage & {
        error?: string;
        reconnect?: boolean;
      };
      if (current !== generation.current) return;
      if (!response.ok) {
        setReconnect(!!page.reconnect);
        throw new Error(page.error ?? "Could not load subscriptions");
      }
      setReconnect(false);
      setChannels((previous) => [
        ...new Map(
          [...(refresh || changed ? [] : previous), ...page.channels].map(
            (c) => [c.id, c],
          ),
        ).values(),
      ]);
      setCursor(page.nextCursor);
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function importSelected() {
    if (!account?.account?.id) return;
    setBusy(true);
    setError(undefined);
    setSaved(undefined);
    try {
      const response = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.account.id,
          selectedIds: [...selected],
          mode,
          backfill,
        } satisfies CreatorImport),
      });
      const result = (await response.json()) as ImportCreatorsResult & {
        error?: string;
        reconnect?: boolean;
      };
      if (!response.ok) {
        setReconnect(!!result.reconnect);
        throw new Error(result.error ?? "Couldn't add those channels");
      }
      await onImport();
      setSaved(
        `Added ${result.imported.length} channel${result.imported.length === 1 ? "" : "s"}${result.existing.length ? `; ${result.existing.length} you were already watching` : ""}`,
      );
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const visible = channels.filter((c) =>
    `${c.name} ${c.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section
      aria-label="Add from your subscriptions"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2 className="font-semibold">Add from your subscriptions</h2>
      <p className="text-sm text-muted-foreground">
        Pick channels you already follow on YouTube. YouTube account:{" "}
        {account?.account?.name ?? "not connected"}.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void load(true)}
      >
        {channels.length ? "Reload my subscriptions" : "Show my subscriptions"}
      </Button>
      {(reconnect || !account?.connected) && (
        <Link href="/settings#accounts" className="ml-3 text-sm underline">
          {account?.needsReconnect || reconnect
            ? "Sign in to YouTube again"
            : "Connect your YouTube account"}
        </Link>
      )}
      {channels.length > 0 && (
        <>
          <Input
            aria-label="Search subscriptions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || visible.length === 0}
              onClick={() =>
                setSelected(
                  (previous) =>
                    new Set([...previous, ...visible.map((c) => c.id)]),
                )
              }
            >
              Select all shown
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </Button>
            <span className="text-sm">
              {channels.length} channels · {selected.size} selected
            </span>
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border p-2">
            {visible.map((c) => (
              <label key={c.id} className="flex items-center gap-3 p-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Select ${c.name}`}
                  checked={selected.has(c.id)}
                  disabled={busy}
                  onChange={(e) =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      return next;
                    })
                  }
                />
                {c.thumbnail && (
                  <img
                    src={c.thumbnail}
                    alt=""
                    className="size-7 rounded-full"
                  />
                )}
                <span>{c.name}</span>
              </label>
            ))}
            {visible.length === 0 && (
              <p className="p-2 text-sm">
                No channels match that name.
              </p>
            )}
          </div>
          {cursor && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void load(false)}
            >
              Show more
            </Button>
          )}
          <label className="flex flex-col gap-1 text-sm">
            What to do with their new videos
            <Select
              aria-label="What to do with their new videos"
              value={mode}
              disabled={busy}
              onChange={(e) => setMode(e.target.value as CreatorImport["mode"])}
            >
              <option value="manual">Just add them for now</option>
              <option value="automatic_drafts">
                Make clips automatically
              </option>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={backfill}
              disabled={busy}
              onChange={(e) => setBackfill(e.target.checked)}
            />
            Also make clips from each one's newest video now
          </label>
          <p className="text-xs text-muted-foreground">
            Channels you already watch keep their settings. Nothing is posted
            without your OK.
          </p>
          <Button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() => void importSelected()}
          >
            {busy ? "Working…" : `Add ${selected.size} channel${selected.size === 1 ? "" : "s"}`}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm">
          {saved}
        </p>
      )}
    </section>
  );
}
