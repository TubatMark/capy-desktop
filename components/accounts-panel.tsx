"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, Check, ChevronDown, Link2, Loader2, LogOut, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/hooks/use-job";
import { AUDIENCES } from "@/lib/post-time";
import type { AccountPublic, AppSettings, Platform } from "@/lib/types";

export const PLATFORM_NAME: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

const HINTS: Record<Platform, { id: string; secret: string; note: string }> = {
  youtube: { id: "OAuth client ID", secret: "Client secret", note: "Posts as Shorts. Until Google audits your project (free), uploads stay private and capy reminds you to make them public." },
  instagram: { id: "App ID", secret: "App secret", note: "Posts Reels to an Instagram Business or Creator account linked to a Facebook Page." },
  tiktok: { id: "Client key", secret: "Client secret", note: "Until TikTok audits your app, clips go to your TikTok inbox and you tap Post." },
};

/** Settings → Accounts: the user's own developer apps, sign-in, and posting options. */
export function AccountsPanel({ initial }: { initial: AppSettings }) {
  const [accounts, setAccounts] = useState<AccountPublic[] | null>(null);
  const [audience, setAudience] = useState(initial.postingAudience ?? "us-east");
  const [paused, setPaused] = useState(!!initial.postingPaused);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await api<AccountPublic[]>("/api/accounts"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function saveSetting(patch: Partial<AppSettings>) {
    setErr(null);
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card id="accounts">
      <CardHeader>
        <CardTitle>Posting accounts</CardTitle>
        <CardDescription>
          Connect YouTube, Instagram and TikTok with your own free developer apps. Rendered clips wait in{" "}
          <Link href="/queue" className="underline underline-offset-2">
            Queue
          </Link>{" "}
          until you approve them, then post at staggered times (at most 2 a day per platform).{" "}
          <Link href="/settings/posting-setup" className="inline-flex items-center gap-1 underline underline-offset-2">
            <BookOpen className="size-3.5" /> Setup guide
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Post for viewers in</Label>
            <Select
              value={audience}
              onChange={(e) => {
                setAudience(e.target.value);
                void saveSetting({ postingAudience: e.target.value });
              }}
            >
              {AUDIENCES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">Slots are picked in this time zone.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Posting</Label>
            <Button
              type="button"
              variant="outline"
              className="justify-start"
              onClick={() => {
                setPaused(!paused);
                void saveSetting({ postingPaused: !paused });
              }}
            >
              {paused ? <Play /> : <Pause />} {paused ? "Paused: resume posting" : "On: pause posting"}
            </Button>
            <p className="text-xs text-muted-foreground">Pausing keeps the queue; nothing posts until you resume.</p>
          </div>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {!accounts ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading accounts…
          </p>
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => (
              <AccountCard key={a.platform} a={a} onChange={(next) => setAccounts((all) => all!.map((x) => (x.platform === next.platform ? next : x)))} reload={load} />
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">Your app keys and sign-ins stay in a private file on this computer and are only sent to the platform itself.</p>
      </CardContent>
    </Card>
  );
}

function AccountCard({ a, onChange, reload }: { a: AccountPublic; onChange: (a: AccountPublic) => void; reload: () => Promise<void> }) {
  const [clientId, setClientId] = useState(a.clientId ?? "");
  const [secret, setSecret] = useState(a.clientSecret ?? "");
  const [busy, setBusy] = useState<"save" | "connect" | "paste" | "disconnect" | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const name = PLATFORM_NAME[a.platform];
  const h = HINTS[a.platform];

  useEffect(() => () => void (poll.current && clearInterval(poll.current)), []);

  async function put(patch: Record<string, unknown>) {
    setErr(null);
    const next = await api<AccountPublic>(`/api/accounts/${a.platform}`, { method: "PUT", body: JSON.stringify(patch) });
    onChange(next);
    return next;
  }

  async function connect() {
    setBusy("connect");
    setErr(null);
    try {
      if (clientId.trim() !== (a.clientId ?? "") || (secret && secret !== a.clientSecret)) await put({ clientId: clientId.trim(), clientSecret: secret.trim() });
      const { url } = await api<{ url: string }>(`/api/accounts/${a.platform}/connect`, { method: "POST" });
      window.open(url, "_blank", "noopener");
      setWaiting(true);
      const started = Date.now();
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        const list = await api<AccountPublic[]>("/api/accounts").catch(() => null);
        const me = list?.find((x) => x.platform === a.platform);
        if ((me?.connected && me.account) || Date.now() - started > 5 * 60_000) {
          clearInterval(poll.current!);
          setWaiting(false);
          if (me) onChange(me);
        }
      }, 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const status = a.needsReconnect ? (
    <Badge variant="warning">Reconnect needed</Badge>
  ) : a.connected ? (
    <Badge variant="success">
      <Check className="mr-1 size-3" /> {a.account?.name ?? "Connected"}
    </Badge>
  ) : a.configured ? (
    <Badge variant="secondary">Not connected</Badge>
  ) : (
    <Badge variant="outline">Not set up</Badge>
  );

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {a.account?.avatar && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.account.avatar} alt="" className="size-6 rounded-full" />
          )}
          <h3 className="font-semibold">{name}</h3>
          {status}
        </div>
        <Link href={`/settings/posting-setup#${a.platform}`} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          How to set this up
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">{h.note}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${a.platform}-id`}>{h.id}</Label>
          <Input id={`${a.platform}-id`} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${a.platform}-secret`}>{h.secret}</Label>
          <Input id={`${a.platform}-secret`} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
      </div>

      {a.platform === "tiktok" && (
        <div className="flex flex-col gap-1.5">
          <Label>How to post</Label>
          <Select value={a.mode ?? "inbox"} onChange={(e) => void put({ mode: e.target.value }).catch((x) => setErr(String(x.message ?? x)))}>
            <option value="inbox">Send to my TikTok inbox (works now; I tap Post)</option>
            <option value="direct">Post directly (after TikTok approves my app; reconnect after switching)</option>
          </Select>
        </div>
      )}
      {a.platform === "instagram" && (a.choices?.length ?? 0) > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label>Post as</Label>
          <Select value={a.igUserId ?? ""} onChange={(e) => void put({ igUserId: e.target.value }).catch((x) => setErr(String(x.message ?? x)))}>
            <option value="" disabled>
              Pick an account
            </option>
            {a.choices!.map((c) => (
              <option key={c.id} value={c.id}>
                @{c.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={connect} disabled={busy !== null || !clientId.trim() || !secret.trim()}>
          {busy === "connect" || waiting ? <Loader2 className="animate-spin" /> : <Link2 />} {a.connected ? "Reconnect" : a.needsReconnect ? "Reconnect" : "Connect"}
        </Button>
        {a.connected && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("disconnect");
              try {
                onChange(await api<AccountPublic>(`/api/accounts/${a.platform}`, { method: "DELETE" }));
              } finally {
                setBusy(null);
              }
            }}
          >
            <LogOut /> Disconnect
          </Button>
        )}
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={a.autoPost} onChange={(e) => void put({ autoPost: e.target.checked }).catch((x) => setErr(String(x.message ?? x)))} />
          Queue rendered clips here
        </label>
      </div>
      {waiting && <p className="text-xs text-muted-foreground">Finish signing in in your browser. This updates by itself when you're done.</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {(waiting || a.configured) && !a.connected && (
        <div>
          <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setPasteOpen(!pasteOpen)} aria-expanded={pasteOpen}>
            <ChevronDown className={`size-3 transition-transform ${pasteOpen ? "rotate-180" : ""}`} /> Didn't come back? Paste the address from your browser
          </button>
          {pasteOpen && (
            <div className="mt-2 flex gap-2">
              <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost:53682/callback?code=…" spellCheck={false} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!pasted.trim() || busy !== null}
                onClick={async () => {
                  setBusy("paste");
                  setErr(null);
                  try {
                    onChange(await api<AccountPublic>(`/api/accounts/${a.platform}/callback`, { method: "POST", body: JSON.stringify({ url: pasted }) }));
                    setWaiting(false);
                    setPasted("");
                    await reload();
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "paste" ? <Loader2 className="animate-spin" /> : <Check />} Finish
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
