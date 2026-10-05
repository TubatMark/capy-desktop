"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Languages, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/hooks/use-job";
import type { ClipState } from "@/lib/types";

/** "Replace" on a pick card: ask the AI for a different moment that avoids what was wrong with this one. */
export function ReplacePopover({ jobId, clip }: { jobId: string; clip: ClipState }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(clip.review?.problem ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function replace() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/jobs/${jobId}/clips/${clip.n}/replace`, { method: "POST", body: JSON.stringify({ reason }) });
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setReason(clip.review?.problem ?? "");
          setErr(null);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button size="sm" variant="secondary" className="h-7 gap-1 px-2 text-xs">
          <RefreshCw className="size-3" /> Replace
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-xl border bg-card p-5 shadow-2xl outline-none">
          <div className="space-y-1">
            <Dialog.Title className="font-semibold">Replace this clip</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              AI looks for a different moment in the video and avoids the problem you describe. The other picks stay as they are.
            </Dialog.Description>
          </div>
          <Textarea value={reason} rows={3} onChange={(e) => setReason(e.target.value)} placeholder="What's wrong with this pick? e.g. ends before the punchline" />
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button onClick={replace} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} {busy ? "Finding a new moment…" : "Replace"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Retry the English caption translation for one clip. */
export function RetryTranslation({ jobId, n }: { jobId: string; n: number }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      className="h-7 gap-1 px-2 text-xs"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await api(`/api/jobs/${jobId}/clips/${n}/translate`, { method: "POST" }).catch(() => {});
        setBusy(false);
      }}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Languages className="size-3" />} Retry translation
    </Button>
  );
}
