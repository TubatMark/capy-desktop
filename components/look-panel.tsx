"use client";
import { Loader2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LOOK_LIMITS, VIBES, defaultLook, looksEqual, type Look } from "@/lib/look";

/**
 * Per-video caption/hook styling and colour vibe. Edits go up through `onChange` so the
 * preview updates live; `onSave` writes the look to the job, which applies to every clip.
 */
export function LookPanel({
  look,
  style,
  dirty,
  saving,
  staleCount,
  error,
  onChange,
  onSave,
  onReset,
}: {
  look: Look;
  style: "bold" | "clean";
  dirty: boolean;
  saving: boolean;
  /** Clips already rendered with the old look; they need a re-render after saving. */
  staleCount: number;
  error?: string | null;
  onChange: (look: Look) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const hook = (p: Partial<Look["hook"]>) => onChange({ ...look, hook: { ...look.hook, ...p } });
  const atDefaults = looksEqual(look, defaultLook(style));

  return (
    <div className="space-y-4 rounded-xl border bg-card p-5">
      <h2 className="font-semibold">Look</h2>

      <section className="space-y-2">
        <Label>Vibe</Label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Colour vibe">
          {VIBES.map((v) => {
            const active = v.id === look.vibe;
            return (
              <button
                key={v.id}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ ...look, vibe: v.id })}
                className={
                  "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors " +
                  (active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground")
                }
              >
                {v.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <Label>Captions</Label>
        <Range label="Size" value={look.size} display={`${look.size}px`} min={LOOK_LIMITS.size.min} max={LOOK_LIMITS.size.max} onChange={(n) => onChange({ ...look, size: n })} />
        <Range label="Position" value={look.bottom} display={`${Math.round(look.bottom * 100)}% from bottom`} min={LOOK_LIMITS.bottom.min} max={LOOK_LIMITS.bottom.max} step={0.005} onChange={(n) => onChange({ ...look, bottom: n })} />
        <Range label="Words per line" value={look.wordsPerLine} display={String(look.wordsPerLine)} min={LOOK_LIMITS.wordsPerLine.min} max={LOOK_LIMITS.wordsPerLine.max} onChange={(n) => onChange({ ...look, wordsPerLine: n })} />
        <div className="grid grid-cols-3 gap-2">
          <Swatch label="Text" value={look.text} onChange={(c) => onChange({ ...look, text: c })} />
          <Swatch label="Highlight" value={look.highlight} onChange={(c) => onChange({ ...look, highlight: c })} />
          <Swatch label="Outline" value={look.outline} onChange={(c) => onChange({ ...look, outline: c })} />
        </div>
        <Range label="Outline thickness" value={look.outlineWidth} display={look.outlineWidth === 0 ? "none" : `${look.outlineWidth}px`} min={LOOK_LIMITS.outlineWidth.min} max={LOOK_LIMITS.outlineWidth.max} onChange={(n) => onChange({ ...look, outlineWidth: n })} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={look.box} onChange={(e) => onChange({ ...look, box: e.target.checked })} />
          Dark box behind text
        </label>
      </section>

      <section className="space-y-3">
        <Label>Hook</Label>
        <Range label="Size" value={look.hook.size} display={`${look.hook.size}px`} min={LOOK_LIMITS.hookSize.min} max={LOOK_LIMITS.hookSize.max} onChange={(n) => hook({ size: n })} />
        <Range label="Position" value={look.hook.top} display={`${Math.round(look.hook.top * 100)}% from top`} min={LOOK_LIMITS.hookTop.min} max={LOOK_LIMITS.hookTop.max} step={0.005} onChange={(n) => hook({ top: n })} />
        <div className="grid grid-cols-3 gap-2">
          <Swatch label="Text" value={look.hook.text} onChange={(c) => hook({ text: c })} />
          <Swatch label="Box" value={look.hook.box} onChange={(c) => hook({ box: c })} />
        </div>
      </section>

      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onSave} disabled={!dirty || saving} variant={dirty ? "default" : "outline"} className="flex-1">
            {saving ? <Loader2 className="animate-spin" /> : <Wand2 />} Apply to all clips
          </Button>
          <Button variant="ghost" onClick={onReset} disabled={atDefaults || saving}>
            Reset to defaults
          </Button>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {staleCount > 0 && (
          <p className="text-xs text-muted-foreground">
            Applies to every clip of this video. {staleCount} rendered {staleCount === 1 ? "clip" : "clips"} will need a re-render.
          </p>
        )}
      </div>
    </div>
  );
}

function Range({ label, value, display, min, max, step = 1, onChange }: { label: string; value: number; display: string; min: number; max: number; step?: number; onChange: (n: number) => void }) {
  return (
    <label className="block space-y-1">
      <span className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{display}</span>
      </span>
      <input type="range" className="block h-1.5 w-full cursor-pointer accent-primary" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Swatch({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
      <input
        type="color"
        className="size-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0 ring-1 ring-border [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
        value={value}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        aria-label={`${label} colour`}
      />
      <span className="truncate text-xs">{label}</span>
    </label>
  );
}
