"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CaptionCue, ProjectDocument } from "@/lib/studio/types";
import type { EditOperation } from "@/lib/studio/operations";
export function CaptionsPanel({
  document,
  frame,
  onFrame,
  onEdit,
}: {
  document: ProjectDocument;
  frame: number;
  onFrame: (frame: number) => void;
  onEdit: (op: EditOperation) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const cue =
    document.captionCues.find((c) => c.id === selected) ??
    document.captionCues[0];
  const [draft, setDraft] = useState<CaptionCue>();
  useEffect(() => setDraft(cue ? structuredClone(cue) : undefined), [cue]);
  return (
    <section
      aria-label="Captions inspector"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Captions</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const id = crypto.randomUUID();
            onEdit({
              type: "add-caption",
              cue: {
                id,
                text: "New caption",
                startFrame: frame,
                durationFrames: Math.max(
                  1,
                  Math.round(
                    (2 * document.fps.numerator) / document.fps.denominator,
                  ),
                ),
                x: 0.5,
                y: 0.8,
                fontSize: 64,
                color: "#ffffff",
              },
            });
            setSelected(id);
          }}
        >
          Add caption
        </Button>
      </div>
      {!document.sourceWords?.length && (
        <p className="text-xs text-muted-foreground">
          No source transcript is available. Add captions manually; no
          transcription service is contacted.
        </p>
      )}
      {!!document.captionCues.length && (
        <select
          aria-label="Selected caption"
          className="w-full rounded border bg-background p-2 text-xs"
          value={cue?.id}
          onChange={(e) => {
            setSelected(e.target.value);
            const next = document.captionCues.find(
              (c) => c.id === e.target.value,
            );
            if (next) onFrame(next.startFrame);
          }}
        >
          {document.captionCues.map((c) => (
            <option key={c.id} value={c.id}>
              {c.startFrame}f · {c.text}
            </option>
          ))}
        </select>
      )}
      {draft && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            onEdit({
              type: "caption",
              cueId: draft.id,
              changes: {
                text: draft.text,
                startFrame: draft.startFrame,
                durationFrames: draft.durationFrames,
                x: draft.x ?? 0.5,
                y: draft.y ?? 0.8,
                fontSize: draft.fontSize ?? 64,
                color: draft.color ?? "#ffffff",
                fontFamily: draft.fontFamily ?? "Arial",
              },
            });
          }}
        >
          <label className="block text-xs">
            Text
            <Input
              aria-label="Caption text"
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </label>
          {(
            [
              {
                key: "startFrame",
                label: "Caption start frame",
                value: draft.startFrame,
                min: 0,
                step: 1,
              },
              {
                key: "durationFrames",
                label: "Caption duration frames",
                value: draft.durationFrames,
                min: 1,
                step: 1,
              },
              {
                key: "x",
                label: "Caption horizontal position",
                value: draft.x ?? 0.5,
                min: 0,
                max: 1,
                step: 0.01,
              },
              {
                key: "y",
                label: "Caption vertical position",
                value: draft.y ?? 0.8,
                min: 0,
                max: 1,
                step: 0.01,
              },
              {
                key: "fontSize",
                label: "Caption font size",
                value: draft.fontSize ?? 64,
                min: 1,
                max: 1000,
                step: 1,
              },
            ] as const
          ).map((field) => (
            <label key={field.key} className="block text-xs">
              {field.label}
              <Input
                aria-label={field.label}
                type="number"
                min={field.min}
                max={"max" in field ? field.max : undefined}
                step={field.step}
                value={field.value}
                onChange={(e) =>
                  setDraft({ ...draft, [field.key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          <label className="block text-xs">
            Caption font
            <select
              aria-label="Caption font"
              className="mt-1 w-full rounded border bg-background p-2"
              value={draft.fontFamily ?? "Arial"}
              onChange={(e) =>
                setDraft({ ...draft, fontFamily: e.target.value })
              }
            >
              {["Arial", "Georgia", "monospace"].map((font) => (
                <option key={font}>{font}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            Caption color
            <input
              aria-label="Caption color"
              type="color"
              value={draft.color ?? "#ffffff"}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
            />
          </label>
          <Button size="sm" type="submit">
            Apply caption
          </Button>
          {!draft.source && (
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() =>
                onEdit({ type: "remove-caption", cueId: draft.id })
              }
            >
              Remove caption
            </Button>
          )}
        </form>
      )}
    </section>
  );
}
