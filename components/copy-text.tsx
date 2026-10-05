"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** A monospace value with a copy button (redirect URIs, captions). */
export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="my-1.5 flex w-fit max-w-full items-center gap-2 rounded-md border bg-background px-2 py-1">
      <code className="truncate font-mono text-xs">{text}</code>
      <button
        type="button"
        aria-label="Copy"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
