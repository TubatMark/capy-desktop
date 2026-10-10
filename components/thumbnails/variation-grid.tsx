"use client";
import type { ThumbnailStudioDocument } from "@/lib/thumbnails";
export function VariationGrid({
  designs,
  selected,
  onSelect,
}: {
  designs: ThumbnailStudioDocument[];
  selected?: string;
  onSelect: (doc: ThumbnailStudioDocument) => void;
}) {
  return (
    <section
      aria-label="Design variations"
      className="grid gap-3 sm:grid-cols-3"
    >
      {designs.map((doc) => (
        <button
          key={doc.id}
          type="button"
          aria-pressed={selected === doc.id}
          onClick={() => onSelect(doc)}
          className={`rounded-xl border p-3 text-left ${selected === doc.id ? "border-primary ring-2 ring-primary" : ""}`}
        >
          <img
            src={doc.versions.filter((v) => v.format === "png").at(-1)?.path}
            alt={doc.name}
            className="max-h-44 w-full rounded object-contain"
          />
          <p className="mt-2 text-sm font-medium">
            {doc.layout} · version {doc.editRevision}
          </p>
        </button>
      ))}
    </section>
  );
}
