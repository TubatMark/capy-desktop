"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { AccessGate } from "@/components/access-gate";
import { api } from "@/hooks/use-job";
import type { JobState, JobSettings } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";

export function UrlForm({ large = false }: { large?: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<JobSettings>(DEFAULT_SETTINGS);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const job = await api<JobState>("/api/jobs", { method: "POST", body: JSON.stringify({ url, settings: s }) });
      router.push(`/v/${job.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full min-w-0">
      {/* input on its own row below sm; the button row then fills the width */}
      <div className={large ? "flex flex-col gap-3 sm:flex-row" : "flex flex-wrap gap-2"}>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a YouTube link…"
          className={large ? "h-12 min-w-0 flex-1 text-base" : "min-w-0 flex-1"}
          autoFocus={large}
          required
        />
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" size={large ? "lg" : "default"} className={large ? "px-3" : ""} onClick={() => setOpen((o) => !o)} aria-label="Clip settings" aria-expanded={open}>
            <Settings2 />
          </Button>
          <AccessGate action="createJob">
            <Button type="submit" size={large ? "lg" : "default"} className="flex-1" disabled={busy || !url.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              Make clips
            </Button>
          </AccessGate>
        </div>
      </div>
      {err && <p className="mt-2 break-words text-sm text-red-600">{err}</p>}
      {open && (
        <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl border bg-card p-4 text-left sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Clips">
            <Input type="number" min={1} max={30} value={s.count} onChange={(e) => setS({ ...s, count: Number(e.target.value) })} />
          </Field>
          <Field label="Min sec">
            <Input type="number" min={5} value={s.minSec} onChange={(e) => setS({ ...s, minSec: Number(e.target.value) })} />
          </Field>
          <Field label="Max sec">
            <Input type="number" min={5} value={s.maxSec} onChange={(e) => setS({ ...s, maxSec: Number(e.target.value) })} />
          </Field>
          <Field label="Layout">
            <Select value={s.layout} onChange={(e) => setS({ ...s, layout: e.target.value as JobSettings["layout"] })}>
              <option value="center">Center crop</option>
              <option value="blur">Blur bars</option>
            </Select>
          </Field>
          <Field label="Captions">
            <Select value={s.style} onChange={(e) => setS({ ...s, style: e.target.value as JobSettings["style"] })}>
              <option value="bold">Bold</option>
              <option value="clean">Clean</option>
            </Select>
          </Field>
          <Field label="Source">
            <Select value={s.maxRes} onChange={(e) => setS({ ...s, maxRes: Number(e.target.value) })}>
              <option value={2160}>Up to 4K</option>
              <option value={1440}>Up to 1440p</option>
              <option value={1080}>1080p (faster)</option>
            </Select>
          </Field>
          <Field label="Focus (optional)" className="col-span-2 sm:col-span-3 lg:col-span-6">
            <Input value={s.focus ?? ""} onChange={(e) => setS({ ...s, focus: e.target.value || undefined })} placeholder='e.g. "every joke that landed" or "the parts about money"' />
          </Field>
        </div>
      )}
    </form>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
