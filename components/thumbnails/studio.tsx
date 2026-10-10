"use client";
import { useCallback, useEffect, useState } from "react";
import type {
  FrameCandidate,
  ThumbnailAspect,
  ThumbnailSourceRef,
  ThumbnailStudioDocument,
} from "@/lib/thumbnails";
import { THUMBNAIL_DIMENSIONS } from "@/lib/thumbnails";
import { VariationGrid } from "./variation-grid";
import { FramePicker } from "./frame-picker";
import { LayerEditor } from "./layer-editor";
async function request<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await res.json();
  if (!res.ok) throw Error(data.error ?? "Request failed");
  return data;
}
type Data = {
  source?: ThumbnailSourceRef;
  document?: ThumbnailStudioDocument;
  designs: ThumbnailStudioDocument[];
  frames: FrameCandidate[];
  history?: ThumbnailStudioDocument[];
  packages?: { id: string; label: string }[];
};
export function ThumbnailStudio({
  id,
  legacy,
  sourceQuery,
}: {
  id: string;
  legacy?: { jobId: string; clipN: number };
  sourceQuery?: string;
}) {
  const [data, setData] = useState<Data>({ designs: [], frames: [] }),
    [doc, setDoc] = useState<ThumbnailStudioDocument>(),
    [source, setSource] = useState<ThumbnailSourceRef>(),
    [selectedFrame, setSelectedFrame] = useState<string>(),
    [headline, setHeadline] = useState("A closer look"),
    [aspect, setAspect] = useState<ThumbnailAspect>("landscape"),
    [text, setText] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [dirty, setDirty] = useState(false),
    [packageId, setPackageId] = useState("");
  const load = useCallback(
    async (selectedId?: string) => {
      const target = selectedId ?? (id !== "new" ? id : undefined);
      const url = target
        ? `/api/thumbnails/${target}`
        : `/api/thumbnails?${legacy ? new URLSearchParams({ jobId: legacy.jobId, clipN: String(legacy.clipN) }) : sourceQuery ? new URLSearchParams({ source: sourceQuery }) : ""}`;
      const next = await request<Data>(url);
      setData(next);
      setSource(next.document?.sourceIdentity ?? next.source);
      if (next.document) {
        setDoc(next.document);
        setAspect(next.document.aspectPreset);
        setSelectedFrame(
          next.document.layers.find((l) => l.id === "source")?.assetId,
        );
        setDirty(false);
      }
      return next;
    },
    [id, legacy?.jobId, legacy?.clipN, sourceQuery],
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function awaitJob(jobId: string) {
    for (let i = 0; i < 120; i++) {
      const job = await request<{ status: string; error?: string }>(
        `/api/thumbnails/jobs/${jobId}`,
      );
      if (job.status === "complete") return;
      if (["needs_action", "cancelled"].includes(job.status))
        throw Error(
          job.error ?? "Generation failed; previous design preserved",
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw Error("Generation is still running. Reload to check saved designs.");
  }
  async function generate(
    frameTimeUs?: number,
    frameKind?: "clean" | "finished",
    framesOnly = false,
  ) {
    if (!source) return;
    await action(async () => {
      setStatus(
        framesOnly
          ? "Extracting source frames…"
          : "Generating three variations…",
      );
      const job = await request<{ id: string }>("/api/thumbnails", {
        source,
        aspect,
        headline: doc?.layers.find((l) => l.kind === "text")?.text ?? headline,
        requestId: crypto.randomUUID(),
        action: framesOnly ? "frames" : "generate",
        frameTimeUs,
        frameKind,
        ...(!framesOnly && selectedFrame
          ? { selectedFrameIds: [selectedFrame] }
          : {}),
        allowCloud: !framesOnly,
      });
      await awaitJob(job.id);
      const next = await load(doc?.id);
      if (!doc && !framesOnly && next.designs[0])
        await load(next.designs[0].id);
      setStatus(
        framesOnly
          ? "Frames ready. Choose one to replace the source locally."
          : "Three variations ready.",
      );
    });
  }
  async function save() {
    if (!doc) return;
    await action(async () => {
      const res = await fetch(`/api/thumbnails/${doc.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: doc,
          expectedRevision: doc.editRevision,
        }),
      });
      const next = await res.json();
      if (!res.ok) throw Error(next.error);
      await load(doc.id);
      setStatus("Saved locally. No image generation call.");
    });
  }
  async function regenerate(kind: "variation" | "background") {
    if (!doc) return;
    await action(async () => {
      const record = await request<{ id: string; jobId: string }>(
        `/api/thumbnails/${doc.id}/regenerate`,
        {
          expectedRevision: doc.editRevision,
          kind,
          requestId: crypto.randomUUID(),
        },
      );
      setStatus("Explicit regeneration queued; image budget applies.");
      await awaitJob(record.jobId);
      const result = await request<{ state: string; error?: string }>(
        `/api/thumbnails/${doc.id}/regenerate?requestId=${record.id}`,
      );
      if (result.state !== "applied")
        throw Error(
          result.error ?? "Regeneration did not replace the selected design",
        );
      await load(doc.id);
      setStatus("Regeneration saved as a new version.");
    });
  }
  async function zip() {
    if (!doc) return;
    await action(async () => {
      const res = await fetch(`/api/thumbnails/${doc.id}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: data.designs.slice(0, 3).map((d) => ({
            id: d.id,
            revision: d.editRevision,
            options: { aspect, format: "png", text },
          })),
        }),
      });
      if (!res.ok) {
        const response = await res.json();
        throw Error(response.error);
      }
      const url = URL.createObjectURL(await res.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = "capy-thumbnails.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(
        "ZIP downloaded. Downloads do not attach or approve a package.",
      );
    });
  }
  const edit = (next: ThumbnailStudioDocument) => {
    setDoc(next);
    setDirty(true);
  };
  const preview = doc?.versions.filter((v) => v.format === "png").at(-1)?.path;
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header>
        <a href="/studio" className="text-sm underline">
          Video Studio
        </a>
        <h1 className="mt-2 text-3xl font-semibold">Thumbnail Studio</h1>
        <p className="text-muted-foreground">
          Edit and download from your actual footage. A posting account is
          optional for downloads.
        </p>
      </header>
      {error && (
        <p role="alert" className="rounded border border-red-500 p-3">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {doc?.reviewState === "stale" && (
        <p className="rounded border border-amber-500 p-3">
          The footage changed. Saved versions remain downloadable; attach a
          design from the current edit.
        </p>
      )}
      <VariationGrid
        designs={data.designs}
        selected={doc?.id}
        onSelect={(next) => {
          if (busy || dirty) return;
          void action(async () => {
            await load(next.id);
          });
        }}
      />
      {!doc && (
        <section className="flex flex-wrap items-end gap-3">
          <label>
            Headline
            <input
              className="block rounded border p-2"
              value={headline}
              maxLength={120}
              onChange={(e) => setHeadline(e.target.value)}
            />
          </label>
          <button
            className="rounded border p-2"
            disabled={busy || !source}
            onClick={() => generate()}
          >
            Generate three variations
          </button>
        </section>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label>
          Aspect preset
          <select
            disabled={busy}
            className="ml-2 rounded border p-2"
            value={aspect}
            onChange={(e) => {
              const selected = e.target.value as ThumbnailAspect;
              setAspect(selected);
              if (doc)
                void action(async () => {
                  const res = await fetch(`/api/thumbnails/${doc.id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      document: { ...doc, aspectPreset: selected },
                      expectedRevision: doc.editRevision,
                    }),
                  });
                  const response = await res.json();
                  if (!res.ok) throw Error(response.error);
                  await load(doc.id);
                  setStatus("Preset recomposed locally as a new version.");
                });
            }}
          >
            {Object.entries(THUMBNAIL_DIMENSIONS).map(([key, dim]) => (
              <option key={key} value={key}>
                {key} · {dim.width} × {dim.height}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={text}
            onChange={(e) => setText(e.target.checked)}
          />{" "}
          Include text in download
        </label>
      </div>
      {doc && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <label>
              Version name
              <input
                className="ml-2 rounded border p-2"
                disabled={busy}
                value={doc.name}
                onChange={(e) => edit({ ...doc, name: e.target.value })}
              />
            </label>
            <div className="rounded-xl border bg-muted p-4">
              <img
                src={preview}
                alt="Saved full-size design"
                className="mx-auto max-h-[500px] w-full object-contain"
              />
              <p className="mt-2 text-sm">
                {dirty
                  ? "Unsaved changes: save to compose the preview and downloads."
                  : `Saved version ${doc.editRevision}`}
              </p>
            </div>
            <section aria-label="320 pixel readability preview">
              <h2 className="mb-2 font-medium">320 px readability preview</h2>
              <img
                src={preview}
                alt="Small thumbnail preview"
                width={320}
                className="w-[320px] max-w-full"
              />
            </section>
            <div className="flex flex-wrap gap-2">
              <button
                disabled={busy || !dirty}
                onClick={save}
                className="rounded bg-primary p-2 text-primary-foreground"
              >
                Save edits
              </button>
              {(["png", "jpg"] as const).map((format) => (
                <a
                  key={format}
                  aria-disabled={dirty || busy}
                  onClick={(e) => {
                    if (dirty || busy) e.preventDefault();
                  }}
                  className="rounded border p-2"
                  href={`/api/thumbnails/${doc.id}/export?${new URLSearchParams({ revision: String(doc.editRevision), aspect, format, text: String(text) })}`}
                  download
                >
                  Download {format.toUpperCase()}
                </a>
              ))}
              <button
                disabled={busy || dirty}
                onClick={zip}
                className="rounded border p-2"
              >
                Download all ZIP
              </button>
              <button
                disabled={busy || dirty}
                onClick={() => regenerate("variation")}
                className="rounded border p-2"
              >
                Regenerate this variation
              </button>
              <button
                disabled={busy || dirty}
                onClick={() => regenerate("background")}
                className="rounded border p-2"
              >
                Regenerate background
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {doc.imageGeneration.reason ??
                `Image generation: ${doc.imageGeneration.status}`}{" "}
              · Provider: {doc.provenance.provider}. Text, crop, color and font
              edits use local composition.
            </p>
            <section className="space-y-2">
              <h2 className="font-semibold">Version history</h2>
              {data.history?.map((version) => (
                <button
                  key={version.editRevision}
                  className="mr-2 rounded border p-2 text-sm"
                  onClick={() => {
                    edit({ ...version, editRevision: doc.editRevision });
                    setAspect(version.aspectPreset);
                  }}
                >
                  Restore {version.name} · v{version.editRevision}
                </button>
              ))}
            </section>
            <section className="space-y-2">
              <h2 className="font-semibold">Attach to publish package</h2>
              <button
                className="rounded border p-2"
                disabled={busy || dirty || doc.reviewState === "stale"}
                onClick={() =>
                  action(async () => {
                    await request(`/api/thumbnails/${doc.id}/review`, {
                      revision: doc.editRevision,
                    });
                    await load(doc.id);
                    setStatus(
                      "Exact thumbnail version reviewed. Package approval is a separate decision.",
                    );
                  })
                }
              >
                Approve thumbnail version
              </button>
              <p className="text-xs text-muted-foreground">
                Thumbnail review: {doc.reviewState}. Check the source, headline
                and small preview before approving.
              </p>
              <select
                aria-label="Publish package"
                className="rounded border p-2"
                value={packageId}
                onChange={(e) => setPackageId(e.target.value)}
              >
                <option value="">Choose a reviewed video package</option>
                {data.packages?.map((pkg) => (
                  <option key={pkg.id} value={pkg.id}>
                    {pkg.label}
                  </option>
                ))}
              </select>
              <button
                className="ml-2 rounded border p-2"
                disabled={
                  busy || dirty || !packageId || doc.reviewState === "stale"
                }
                onClick={() =>
                  action(async () => {
                    await request(`/api/thumbnails/${doc.id}/attach`, {
                      packageId,
                      revision: doc.editRevision,
                    });
                    await load(doc.id);
                    setPackageId("");
                    setStatus(
                      "Attached exact version. The package needs a new approval. Platform upload has not run.",
                    );
                  })
                }
              >
                Attach selected version
              </button>
              <p className="text-xs text-muted-foreground">
                Attachment creates a new package identity. A download alone
                never changes your video or approval.
              </p>
            </section>
          </div>
          <fieldset disabled={busy}>
            <LayerEditor document={doc} onChange={edit} />
          </fieldset>
        </div>
      )}
      <FramePicker
        frames={data.frames}
        selected={selectedFrame}
        busy={busy}
        onSelect={(frame) => {
          setSelectedFrame(frame.id);
          if (doc)
            edit({
              ...doc,
              layers: doc.layers.map((l) =>
                l.id === "source"
                  ? { ...l, assetId: frame.id, crop: undefined }
                  : l,
              ),
            });
        }}
        onExtract={(time, kind) => generate(time, kind, true)}
      />
      {busy && <p className="text-sm">Working…</p>}
    </main>
  );
}
