"use client";
import { useState } from "react";
import { applyTemplate, type EditTemplate } from "@/lib/studio/templates";
import type { ProjectDocument } from "@/lib/studio/types";
import type { EditOperation } from "@/lib/studio/operations";
export function TemplateBrowser({
  document,
  frame,
  onEdit,
}: {
  document: ProjectDocument;
  frame: number;
  onEdit: (op: EditOperation) => void;
}) {
  const [text, setText] = useState("Your title"),
    [placement, setPlacement] =
      useState<EditTemplate["parameters"]["placement"]>("intro"),
    [error, setError] = useState("");
  return (
    <section
      className="space-y-3 rounded-xl border p-4"
      aria-label="Motion templates"
    >
      <h2 className="font-semibold">Motion templates</h2>
      <label className="block text-sm">
        Template text
        <input
          className="block w-full rounded border p-2"
          aria-label="Template text"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Placement
        <select
          className="ml-2 rounded border p-1"
          aria-label="Template placement"
          value={placement}
          onChange={(e) => setPlacement(e.target.value as typeof placement)}
        >
          {["intro", "outro", "callout", "caption"].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <button
        className="rounded border px-3 py-2"
        onClick={() => {
          try {
            const result = applyTemplate(document, {
              id: "local-title",
              version: 1,
              instanceId: crypto.randomUUID(),
              parameters: {
                text,
                placement,
                durationFrames: Math.round(
                  (document.fps.numerator / document.fps.denominator) * 2,
                ),
                color: "#ffffff",
                startFrame: frame,
              },
            });
            onEdit({ type: "restore", document: result.document });
            setError("");
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Apply local motion template
      </button>
      <p className="text-xs text-muted-foreground">
        Local title v1 · Arial · linear slide. Intro starts at zero; outro
        extends the sequence. Animated captions and callouts begin at the
        playhead.
      </p>
      <p className="text-xs text-muted-foreground">
        Rich Hyperframes templates are unavailable. Existing edits remain
        editable and export through the local renderer.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
