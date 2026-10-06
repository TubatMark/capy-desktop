import { Loader2 } from "lucide-react";
import type { StoryState } from "@/lib/types";

const LABEL: Record<StoryState["status"], string> = {
  planning: "Planning for reach…",
  writing: "Writing…",
  script: "Script ready to check",
  illustrating: "Drawing pages…",
  pages: "Pictures ready",
  rendering: "Making the video…",
  done: "Video ready",
  error: "Needs attention",
};

export function StatusChip({ story }: { story: Pick<StoryState, "status" | "queuedAt"> }) {
  const working = story.status === "planning" || story.status === "writing" || story.status === "illustrating" || story.status === "rendering";
  const tone =
    story.status === "error"
      ? "bg-destructive/15 text-red-700"
      : story.status === "done"
        ? "bg-emerald-500/15 text-emerald-700"
        : working
          ? "bg-secondary text-secondary-foreground"
          : "bg-primary/15 text-foreground";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${tone}`}>
      {working && <Loader2 className="size-3 animate-spin" />}
      {story.status === "done" && story.queuedAt ? "In Queue" : LABEL[story.status]}
    </span>
  );
}
