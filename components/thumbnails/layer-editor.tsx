"use client";
import type { ThumbnailLayer, ThumbnailStudioDocument } from "@/lib/thumbnails";
import { THUMBNAIL_DIMENSIONS } from "@/lib/thumbnails";
export function LayerEditor({
  document,
  onChange,
}: {
  document: ThumbnailStudioDocument;
  onChange: (doc: ThumbnailStudioDocument) => void;
}) {
  const edit = (id: string, patch: Partial<ThumbnailLayer>) =>
    onChange({
      ...document,
      layers: document.layers.map((l) => {
        if (l.id !== id) return l;
        const next = { ...l, ...patch };
        delete next.textLayout;
        return next;
      }),
    });
  const dim = THUMBNAIL_DIMENSIONS[document.aspectPreset];
  return (
    <section aria-label="Layer editor" className="space-y-4">
      <h2 className="font-semibold">Layers</h2>
      {document.layers.map((layer) => (
        <fieldset key={layer.id} className="rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{layer.id}</legend>
          {layer.kind === "text" && (
            <>
              <label className="block text-sm">
                Headline
                <input
                  value={layer.text ?? ""}
                  maxLength={120}
                  onChange={(e) => edit(layer.id, { text: e.target.value })}
                  className="block w-full rounded border p-2"
                />
              </label>
              <label className="text-sm">
                Font
                <select
                  value={layer.fontFamily ?? "Arial Bold"}
                  onChange={(e) =>
                    edit(layer.id, { fontFamily: e.target.value })
                  }
                  className="block rounded border p-2"
                >
                  {[
                    "Arial Bold",
                    "Arial",
                    "DejaVu Sans Bold",
                    "DejaVu Sans",
                  ].map((font) => (
                    <option key={font}>{font}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Font size
                <input
                  type="number"
                  min={16}
                  max={256}
                  value={layer.fontSize ?? 64}
                  onChange={(e) =>
                    edit(layer.id, { fontSize: Number(e.target.value) })
                  }
                  className="block w-24 rounded border p-2"
                />
              </label>
            </>
          )}
          {layer.kind !== "image" && (
            <label className="block text-sm">
              {layer.id} color
              <input
                type="color"
                value={`#${layer.color ?? "ffffff"}`}
                onChange={(e) =>
                  edit(layer.id, { color: e.target.value.slice(1) })
                }
              />
            </label>
          )}
          {layer.id !== "background" && (
            <div className="grid grid-cols-2 gap-2">
              {(["x", "y", "width", "height"] as const).map((key) => (
                <label key={key} className="text-sm">
                  {layer.id} {key}
                  <input
                    type="number"
                    value={layer[key]}
                    min={key === "x" || key === "y" ? 0 : 2}
                    max={
                      key === "x" || key === "width" ? dim.width : dim.height
                    }
                    onChange={(e) =>
                      edit(layer.id, { [key]: Number(e.target.value) })
                    }
                    className="block w-full rounded border p-2"
                  />
                </label>
              ))}
            </div>
          )}
          {layer.id === "source" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(["x", "y", "width", "height"] as const).map((key) => (
                <label key={key} className="text-sm">
                  Crop {key}
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={
                      layer.crop?.[key] ??
                      (key === "width" || key === "height" ? 1 : 0)
                    }
                    onChange={(e) =>
                      edit(layer.id, {
                        crop: {
                          x: 0,
                          y: 0,
                          width: 1,
                          height: 1,
                          ...layer.crop,
                          [key]: Number(e.target.value),
                        },
                      })
                    }
                    className="block w-full rounded border p-2"
                  />
                </label>
              ))}
            </div>
          )}
        </fieldset>
      ))}
    </section>
  );
}
