"use client";
import { useState } from "react";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/hooks/use-job";
import type { AutopilotLogEntry, AutopilotSettings } from "@/lib/longform";

const SWITCHES: { key: keyof AutopilotSettings; label: string; hint: string; warn?: string }[] = [
  { key: "draft", label: "Draft new videos", hint: "Checks the footage regularly and starts a video when a creator has enough. At most 6 wait for review." },
  { key: "upload", label: "Upload as Private", hint: "One a day, once the file checks pass. A video with a file problem waits for you." },
  { key: "publish", label: "Go public", hint: "Books the next open slot, 6 hours or more after processing. A video with a file problem waits for you.", warn: "Videos go public without you watching them. A claim or strike can affect your whole channel." },
  { key: "free", label: "Delete local files", hint: "Removes long-form footage and masters 48 hours after processing, and rendered Shorts 48 hours after posting.", warn: "This permanently deletes files without asking. Footage for Shorts that haven't posted is always kept." },
];

/** The long-form autopilot's switches, one per step, and what it did lately. */
export function AutopilotPanel({ settings, log, onChange }: { settings: AutopilotSettings; log: AutopilotLogEntry[]; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<keyof AutopilotSettings | null>(null);
  async function set(key: keyof AutopilotSettings, value: boolean) {
    setErr(null);
    setConfirming(null);
    try {
      await api("/api/longform", { method: "POST", body: JSON.stringify({ action: "autopilot", settings: { ...settings, [key]: value } }) });
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Long-form autopilot">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Bot className="size-4" /> Long videos
      </h3>
      <ul className="grid gap-3 sm:grid-cols-2">
        {SWITCHES.map((s) => (
          <li key={s.key} className="space-y-1 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--primary)]"
                checked={settings[s.key]}
                onChange={(e) => (e.target.checked && s.warn ? setConfirming(s.key) : set(s.key, e.target.checked))}
              />
              <span>
                <span className="font-medium">{s.label}</span>
                <span className="block text-xs text-muted-foreground">{s.hint}</span>
              </span>
            </label>
            {confirming === s.key && (
              <div className="ml-6 space-y-2 rounded-lg border p-2 text-xs">
                <p>{s.warn}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => set(s.key, true)}>
                    Turn on
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                    Keep off
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {log.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Latest: {log[0]!.text}</summary>
          <ul className="mt-1 space-y-0.5">
            {log.map((l) => (
              <li key={`${l.at}${l.text}`}>
                {new Date(l.at).toLocaleString()}: {l.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
