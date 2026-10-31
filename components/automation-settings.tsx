"use client";
import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Mic, Star } from "lucide-react";
import { AutopilotPanel } from "@/components/autopilot-panel";
import { Label } from "@/components/ui/label";
import { api } from "@/hooks/use-job";
import { creatorName, type AutopilotLogEntry, type AutopilotSettings } from "@/lib/longform";
import type { ShortTestReport } from "@/components/queue/narration-results";
import type { Tuning } from "@/lib/daily-check";
import type { WatchFile } from "@/lib/types";

type Data = { autopilot: AutopilotSettings; autopilotLog: AutopilotLogEntry[]; shortsTest: ShortTestReport };

/** One place for what capy does by itself. Everything starts automatic; each switch hands that step back to the owner. */
export function AutomationSettings() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<Data>("/api/longform?automation=1")
        .then(setData)
        .catch((e) => setErr(e instanceof Error ? e.message : String(e))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section id="automation" aria-label="Automation" className="scroll-mt-4 space-y-4 rounded-xl border bg-card p-5 shadow-sm">
      <div>
        <h2 className="font-semibold">Automation</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">capy does all of this by itself. Turn off anything you&apos;d rather do by hand.</p>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <AutoSchedule />
      {data && <Narration test={data.shortsTest} onChange={load} />}
      <FocusCreators />
      {data && <AutopilotPanel settings={data.autopilot} log={data.autopilotLog} onChange={load} />}
    </section>
  );
}

/** The owner's switch for scheduling clips that pass every check without waiting for approval (on by default). */
function AutoSchedule() {
  const [on, setOn] = useState<boolean | null>(null);
  const [caution, setCaution] = useState(true);
  useEffect(() => {
    void api<{
      settings: { autoSchedule?: boolean; autoScheduleCaution?: boolean };
    }>("/api/settings")
      .then((r) => {
        setOn(r.settings.autoSchedule ?? true);
        setCaution(r.settings.autoScheduleCaution ?? true);
      })
      .catch(() => {});
  }, []);
  return (
    <section className="space-y-2 border-t pt-4" aria-label="Shorts scheduling">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <CalendarClock className="size-4" /> Shorts
      </h3>
      {on !== null && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--primary)]"
            checked={on}
            onChange={async (e) => {
              const next = e.target.checked;
              setOn(next);
              await api("/api/settings", {
                method: "PUT",
                body: JSON.stringify({ autoSchedule: next }),
              }).catch(() => setOn(!next));
            }}
          />
          <span>
            <span className="font-medium">Schedule clips that pass every check without asking me</span>
            <span className="block text-xs text-muted-foreground">
              No AI says don&apos;t post, it isn&apos;t a near-copy of your recent clips, and it has a designed thumbnail. It still waits for its time slot, so you can remove it from Short form before it posts. Turning this off also holds back clips it already
              scheduled.
            </span>
          </span>
        </label>
      )}
      {on && (
        <label className="ml-6 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--primary)]"
            checked={caution}
            onChange={async (e) => {
              const next = e.target.checked;
              setCaution(next);
              await api("/api/settings", {
                method: "PUT",
                body: JSON.stringify({ autoScheduleCaution: next }),
              }).catch(() => setCaution(!next));
            }}
          />
          <span>
            <span className="font-medium">Also schedule clips the AI marked &quot;check this&quot;</span>
            <span className="block text-xs text-muted-foreground">Only clips an AI says not to post wait for you.</span>
          </span>
        </label>
      )}
    </section>
  );
}

function Narration({ test, onChange }: { test: ShortTestReport; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function choose(mode: string) {
    setErr(null);
    try {
      await api("/api/longform", { method: "POST", body: JSON.stringify({ action: "shorts-test", mode }) });
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <section className="space-y-2 border-t pt-4" aria-label="Narration">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Mic className="size-4" /> Narration
      </h3>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor="narrate-mode">Narrated Shorts</Label>
        <select id="narrate-mode" className="rounded-md border bg-background px-2 py-1 text-sm" value={!test.on ? "off" : test.narrateManual ?? "auto"} onChange={(e) => choose(e.target.value)}>
          <option value="auto">Automatic: the daily check decides</option>
          <option value="all">Every new Short</option>
          <option value="half">Half of new Shorts</option>
          <option value="off">None</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        {!test.on ? "Not narrating." : `Now: ${test.narrate === "all" ? "every new Short" : test.narrate === "off" ? "no new Shorts" : "half of new Shorts"}.`} Shorts already made or scheduled don&apos;t change.
      </p>
      {err && <p className="text-sm text-destructive">{err}</p>}
    </section>
  );
}

/** Creators whose clips go first. Offers everyone watched, plus anyone still picked who is no longer watched, so they can be cleared. */
function FocusCreators() {
  const [picked, setPicked] = useState<string[] | null>(null);
  const [watched, setWatched] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api<{ tuning: Tuning }>("/api/daily-check")
      .then((r) => setPicked(r.tuning.focusCreators ?? []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    void api<WatchFile>("/api/automation")
      .then((r) => setWatched(r.channels.map((c) => creatorName(c.name))))
      .catch(() => {});
  }, []);
  async function toggle(name: string, on: boolean) {
    if (!picked) return;
    const before = picked;
    const next = on ? [...picked, name] : picked.filter((c) => c !== name);
    setPicked(next);
    setErr(null);
    try {
      await api("/api/daily-check", { method: "PUT", body: JSON.stringify({ focusCreators: next }) });
    } catch (e) {
      setPicked(before);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  const names = [...new Set([...watched, ...(picked ?? [])])].sort((a, b) => a.localeCompare(b));
  return (
    <section className="space-y-2 border-t pt-4" aria-label="Focus creators">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Star className="size-4" /> Focus creators
      </h3>
      <p className="text-xs text-muted-foreground">Their clips go first among similar ages. Clear them all to treat everyone the same.</p>
      {picked && names.length === 0 && <p className="text-sm text-muted-foreground">Watch a channel in Monitor and it shows up here.</p>}
      {picked && (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {names.map((name) => (
            <li key={name}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={picked.includes(name)} onChange={(e) => void toggle(name, e.target.checked)} />
                {name}
              </label>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
    </section>
  );
}
