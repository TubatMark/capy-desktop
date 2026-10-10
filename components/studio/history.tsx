"use client";
import { Button } from "@/components/ui/button";
import type { ProjectDocument } from "@/lib/studio/types";
export function History({
  entries,
  onRestore,
}: {
  entries: ProjectDocument[];
  onRestore: (document: ProjectDocument) => void;
}) {
  return (
    <details className="rounded-xl border bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Revision history · {entries.length}
      </summary>
      <ul className="mt-3 space-y-2">
        {entries.map((entry) => (
          <li
            key={entry.revision}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <span>
              Revision {entry.revision} · {entry.items.length} clips ·{" "}
              {entry.updatedAt
                ? new Date(entry.updatedAt).toLocaleTimeString()
                : ""}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRestore(entry)}
            >
              Restore revision {entry.revision}
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
