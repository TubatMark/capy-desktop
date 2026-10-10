"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  AssetRef,
  ProjectDocument,
  TimelineItem,
} from "@/lib/studio/types";
import type { EditOperation } from "@/lib/studio/operations";
export function LayersPanel({
  document,
  item,
  assets,
  frame,
  onEdit,
  onSelect,
}: {
  document: ProjectDocument;
  item?: TimelineItem;
  assets: AssetRef[];
  frame: number;
  onEdit: (op: EditOperation) => void;
  onSelect: (id: string) => void;
}) {
  const [assetId, setAssetId] = useState("");
  const [transitionFrames, setTransitionFrames] = useState(12);
  const [text, setText] = useState("");
  useEffect(() => {
    setText(item?.text?.value ?? "");
    setTransitionFrames(item?.transitionOut?.durationFrames ?? 12);
  }, [item?.id, item?.text?.value, item?.transitionOut?.durationFrames]);
  const overlay =
    document.tracks.find((t) => t.id === item?.trackId)?.role === "overlay";
  const available = assets.filter(
    (a) => a.status === "ready" && ["video", "image"].includes(a.kind),
  );
  function addLayer(kind: "text" | "media") {
    const id = crypto.randomUUID(),
      asset = available.find((a) => a.id === (assetId || available[0]?.id));
    if (kind === "media" && !asset) return;
    const duration =
      kind === "text" || asset?.kind === "image"
        ? Math.round((3 * document.fps.numerator) / document.fps.denominator)
        : Math.max(
            1,
            Math.round(
              (asset!.durationUs! * document.fps.numerator) /
                (1000000 * document.fps.denominator),
            ),
          );
    const layer: TimelineItem = {
      id,
      trackId: kind === "text" ? "titles" : "overlays",
      startFrame: frame,
      durationFrames: duration,
      speed: 1,
      transform: { x: 0, y: 0, scale: 0.6, rotation: 0 },
      opacity: 1,
      fit: "contain",
      ...(kind === "text"
        ? { text: { value: "Your title", fontSize: 80, color: "#ffffff" } }
        : {
            assetId: asset!.id,
            sourceInUs: 0,
            sourceOutUs:
              asset!.durationUs ??
              Math.round(
                (duration * 1000000 * document.fps.denominator) /
                  document.fps.numerator,
              ),
            muted: true,
          }),
    };
    onEdit({
      type: "add-layer",
      item: layer,
      kind: kind === "text" ? "text" : "video",
    });
    onSelect(id);
  }
  return (
    <section
      aria-label="Layers inspector"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">Visual layers</h2>
      <Button size="sm" variant="outline" onClick={() => addLayer("text")}>
        Add title overlay
      </Button>
      <select
        aria-label="Overlay media"
        className="w-full rounded border bg-background p-2 text-xs"
        value={assetId || available[0]?.id || ""}
        onChange={(e) => setAssetId(e.target.value)}
      >
        {available.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name ?? a.id}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="outline"
        disabled={!available.length}
        onClick={() => addLayer("media")}
      >
        Add media overlay
      </Button>
      <label className="block text-xs">
        <input
          aria-label="Show safe areas"
          type="checkbox"
          checked={document.safeArea?.enabled ?? false}
          onChange={(e) =>
            onEdit({
              type: "safe-area",
              enabled: e.target.checked,
              inset: document.safeArea?.inset ?? 0.1,
            })
          }
        />{" "}
        Show safe areas
      </label>
      <label className="block text-xs">
        Safe area inset
        <Input
          aria-label="Safe area inset"
          type="number"
          min="0"
          max="0.4"
          step="0.01"
          value={document.safeArea?.inset ?? 0.1}
          onChange={(e) =>
            onEdit({
              type: "safe-area",
              enabled: document.safeArea?.enabled ?? false,
              inset: Number(e.target.value),
            })
          }
        />
      </label>
      {item &&
        document.tracks.find((t) => t.id === item.trackId)?.kind !==
          "audio" && (
          <>
            {overlay && item.text && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onEdit({
                    type: "layer",
                    itemId: item.id,
                    changes: { text: { ...item.text!, value: text } },
                  });
                }}
                className="space-y-2"
              >
                <label className="block text-xs">
                  Title text
                  <Input
                    aria-label="Title text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
                <Button type="submit" size="sm">
                  Apply title
                </Button>
                <label className="block text-xs">
                  Title font size
                  <Input
                    aria-label="Title font size"
                    type="number"
                    min="1"
                    value={item.text.fontSize}
                    onChange={(e) =>
                      onEdit({
                        type: "layer",
                        itemId: item.id,
                        changes: {
                          text: {
                            ...item.text!,
                            fontSize: Number(e.target.value),
                          },
                        },
                      })
                    }
                  />
                </label>
                <label className="block text-xs">
                  Title color
                  <input
                    aria-label="Title color"
                    type="color"
                    value={item.text.color}
                    onChange={(e) =>
                      onEdit({
                        type: "layer",
                        itemId: item.id,
                        changes: {
                          text: { ...item.text!, color: e.target.value },
                        },
                      })
                    }
                  />
                </label>
              </form>
            )}
            {(["x", "y", "scale", "rotation"] as const).map((key) => (
              <label key={key} className="block text-xs">
                Layer {key}
                <Input
                  aria-label={`Layer ${key}`}
                  type="number"
                  step={key === "scale" ? "0.05" : "1"}
                  value={item.transform?.[key] ?? (key === "scale" ? 1 : 0)}
                  onChange={(e) =>
                    onEdit({
                      type: "transform",
                      itemId: item.id,
                      transform: {
                        x: 0,
                        y: 0,
                        scale: 1,
                        rotation: 0,
                        ...item.transform,
                        [key]: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
            ))}
            {overlay && (
              <>
                <label className="block text-xs">
                  Opacity
                  <Input
                    aria-label="Layer opacity"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={item.opacity ?? 1}
                    onChange={(e) =>
                      onEdit({
                        type: "layer",
                        itemId: item.id,
                        changes: { opacity: Number(e.target.value) },
                      })
                    }
                  />
                </label>
                <label className="block text-xs">
                  Fit
                  <select
                    aria-label="Layer fit"
                    className="w-full rounded border bg-background p-2"
                    value={item.fit ?? "contain"}
                    onChange={(e) =>
                      onEdit({
                        type: "layer",
                        itemId: item.id,
                        changes: { fit: e.target.value as "contain" | "cover" },
                      })
                    }
                  >
                    <option value="contain">Fit</option>
                    <option value="cover">Crop to fill</option>
                  </select>
                </label>
              </>
            )}
            {!overlay &&
              document.tracks.find((t) => t.id === item.trackId)?.kind ===
                "video" && (
                <fieldset className="space-y-2 border-t pt-3">
                  <legend className="text-xs">
                    Transition to next footage
                  </legend>
                  <label className="block text-xs">
                    Crossfade duration (frames)
                    <Input
                      aria-label="Crossfade duration frames"
                      type="number"
                      min="1"
                      value={transitionFrames}
                      onChange={(e) =>
                        setTransitionFrames(Number(e.target.value))
                      }
                    />
                  </label>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onEdit({
                          type: "transition",
                          itemId: item.id,
                          kind: "crossfade",
                          durationFrames: transitionFrames,
                        })
                      }
                    >
                      Apply crossfade
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!item.transitionOut}
                      onClick={() =>
                        onEdit({
                          type: "transition",
                          itemId: item.id,
                          kind: "cut",
                          durationFrames: 0,
                        })
                      }
                    >
                      Use cut
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    A crossfade overlaps adjacent footage and shortens the
                    sequence by its duration.
                  </p>
                </fieldset>
              )}
          </>
        )}
    </section>
  );
}
