"use client";
import { useState } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AppSettings } from "@/lib/types";

const BROWSERS: { value: string; label: string }[] = [
  { value: "", label: "None — no cookies" },
  { value: "chrome", label: "Chrome" },
  { value: "safari", label: "Safari" },
  { value: "firefox", label: "Firefox" },
  { value: "brave", label: "Brave" },
  { value: "edge", label: "Edge" },
  { value: "arc", label: "Arc" },
];

export function SettingsForm({ initial, meta }: { initial: AppSettings; meta?: { file: string; outputRoot: string } }) {
  const [saved, setSaved] = useState<AppSettings>(initial);
  const [browser, setBrowser] = useState(initial.browser ?? "");
  const [outputDir, setOutputDir] = useState(initial.outputDir ?? "");
  const [claudeAuth, setClaudeAuth] = useState<AppSettings["claudeAuth"]>(initial.claudeAuth);
  /** A new key typed in this session; empty means "keep what is stored". */
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const patch: Partial<AppSettings> = { browser, outputDir: outputDir.trim(), claudeAuth };
    if (removeKey) patch.apiKey = "";
    else if (apiKey.trim()) patch.apiKey = apiKey.trim();
    try {
      const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const data = (await r.json().catch(() => ({}))) as { settings?: AppSettings; error?: string };
      if (!r.ok || !data.settings) throw new Error(data.error ?? r.statusText);
      setSaved(data.settings);
      setApiKey("");
      setRemoveKey(false);
      setMsg({ kind: "ok", text: "Saved" });
      setTimeout(() => setMsg((m) => (m?.kind === "ok" ? null : m)), 2500);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const outputChanged = (saved.outputDir ?? "") !== outputDir.trim();

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Fetching</CardTitle>
          <CardDescription>How yt-dlp talks to YouTube and where the clips land.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label="Browser cookies" hint="Use your browser's YouTube login. Fixes 429 errors and “confirm you're not a bot”.">
            <Select value={browser} onChange={(e) => setBrowser(e.target.value)} aria-label="Browser cookies">
              {BROWSERS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Output folder"
            hint={
              <>
                Applies after relaunch.{" "}
                {meta ? (
                  <>
                    Currently <code className="break-all font-mono text-[11px]">{meta.outputRoot}</code>.
                  </>
                ) : null}{" "}
                Leave empty for the default (<code className="font-mono text-[11px]">~/Movies/capy</code> in the app).
              </>
            }
          >
            <Input value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="~/Movies/capy" spellCheck={false} autoComplete="off" />
            {outputChanged && <p className="mt-1.5 text-xs text-amber-600">Takes effect the next time you open capy.</p>}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Claude billing</CardTitle>
          <CardDescription>How calls to Claude are billed. Pick the AI and model above.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Billing</legend>
            <Radio
              name="claudeAuth"
              value="subscription"
              checked={claudeAuth === "subscription"}
              onChange={() => setClaudeAuth("subscription")}
              title="Claude subscription"
              hint={
                <>
                  Uses the <code className="font-mono text-[11px]">claude</code> login on this Mac. Personal use only.
                </>
              }
            />
            <Radio
              name="claudeAuth"
              value="apiKey"
              checked={claudeAuth === "apiKey"}
              onChange={() => setClaudeAuth("apiKey")}
              title="API key"
              hint="Pay per call with an Anthropic API key. Required if anyone else uses this app."
            />
          </fieldset>

          {claudeAuth === "apiKey" && (
            <Field
              label="API key"
              hint={
                saved.apiKey ? (
                  <>
                    Stored key ends in <code className="font-mono text-[11px]">{saved.apiKey.slice(-4)}</code>. Type a new one to replace it.
                  </>
                ) : (
                  "Stored on this Mac only, in settings.json (readable by you alone)."
                )
              }
            >
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (e.target.value) setRemoveKey(false);
                }}
                placeholder={saved.apiKey ? saved.apiKey : "sk-ant-…"}
                autoComplete="off"
                spellCheck={false}
                disabled={removeKey}
              />
              {saved.apiKey && (
                <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} className="size-3.5 accent-primary" />
                  Remove the stored key
                </label>
              )}
            </Field>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="submit" size="lg" disabled={busy} className="w-full sm:w-auto">
          {busy ? <Loader2 className="animate-spin" /> : msg?.kind === "ok" ? <Check /> : <Save />}
          {msg?.kind === "ok" ? "Saved" : "Save"}
        </Button>
        {msg?.kind === "err" && (
          <p role="alert" className="text-sm text-red-500">
            {msg.text}
          </p>
        )}
        {meta && (
          <p className="text-xs text-muted-foreground sm:ml-auto">
            Stored in <code className="break-all font-mono text-[11px]">{meta.file}</code>
          </p>
        )}
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Radio({ name, value, checked, onChange, title, hint }: { name: string; value: string; checked: boolean; onChange: () => void; title: string; hint: React.ReactNode }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${checked ? "border-primary/60 bg-accent/60" : "hover:bg-accent/40"}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-0.5 size-4 shrink-0 accent-primary" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
