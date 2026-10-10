"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { api } from "@/hooks/use-job";
import type {
  ProjectDocument,
  ExportPreset,
  TimelineItem,
} from "@/lib/studio/types";
import type { EditOperation } from "@/lib/studio/operations";
import { NormalizedPreview, type PreviewArtifact } from "./preview";
type Work = {
  id: string;
  status: string;
  stage: string;
  error?: string;
  inputRevision: number;
};
export function ExportPanel({
  document,
  saved,
  item,
  onEdit,
}: {
  document: ProjectDocument;
  saved: boolean;
  item?: TimelineItem;
  onEdit: (op: EditOperation) => void;
}) {
  const [aspect, setAspect] = useState<ExportPreset["aspect"]>("portrait"),
    [artifacts, setArtifacts] = useState<PreviewArtifact[]>([]),
    [work, setWork] = useState<Work[]>([]),
    [chosen, setChosen] = useState<string>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [platform, setPlatform] = useState("youtube"),
    [text, setText] = useState(""),
    [review, setReview] = useState(false);
  const refresh = useCallback(async () => {
    const result = await api<{ artifacts: PreviewArtifact[]; work: Work[] }>(
      `/api/studio/projects/${document.id}/render`,
    );
    setArtifacts(result.artifacts);
    setWork(result.work);
  }, [document.id]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      1500,
    );
    return () => clearInterval(timer);
  }, [refresh, document.revision]);
  const active = work.find((w) =>
      ["queued", "running", "retryable"].includes(w.status),
    ),
    artifact = artifacts.find((a) => a.id === chosen) ?? artifacts[0];
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const main =
    item &&
    document.tracks.find((t) => t.id === item.trackId)?.kind === "video" &&
    document.tracks.find((t) => t.id === item.trackId)?.role !== "overlay";
  return (
    <section
      aria-label="Export Studio project"
      className="rounded-xl border bg-card p-4 space-y-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Preview & export</h2>
        <select
          aria-label="Export aspect"
          value={aspect}
          onChange={(e) => setAspect(e.target.value as ExportPreset["aspect"])}
          className="rounded border p-1"
        >
          <option value="portrait">Portrait · 1080×1920</option>
          <option value="landscape">Landscape · 1920×1080</option>
          <option value="square">Square · 1080×1080</option>
          <option value="project">Project canvas</option>
        </select>
        <span className="text-xs text-muted-foreground">
          30 fps · H.264 / AAC
        </span>
        <Button
          disabled={!saved || busy || !!active || !document.items.length}
          onClick={() =>
            void action(() =>
              api(`/api/studio/projects/${document.id}/render`, {
                method: "POST",
                body: JSON.stringify({
                  revision: document.revision,
                  preset: { aspect, fps: 30, codec: "h264-aac" },
                }),
              }),
            )
          }
        >
          Render export
        </Button>
        {!saved && <span className="text-sm">Waiting for edits to save</span>}
      </div>
      {main && (
        <div className="flex flex-wrap gap-3 text-sm">
          <label>
            Footage fit{" "}
            <select
              aria-label="Footage fit"
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
              <option value="cover">Fill</option>
            </select>
          </label>
          <label>
            Color{" "}
            <select
              aria-label="Footage color"
              value={item.colorPreset ?? "neutral"}
              onChange={(e) =>
                onEdit({
                  type: "layer",
                  itemId: item.id,
                  changes: {
                    colorPreset: e.target.value as TimelineItem["colorPreset"],
                  },
                })
              }
            >
              {["neutral", "warm", "cool", "monochrome"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Blur{" "}
            <input
              aria-label="Footage blur"
              type="number"
              min={0}
              max={30}
              className="w-16 border"
              value={item.blur ?? 0}
              onChange={(e) =>
                onEdit({
                  type: "layer",
                  itemId: item.id,
                  changes: { blur: Number(e.target.value) },
                })
              }
            />
          </label>
          <label>
            Center crop %{" "}
            <input
              aria-label="Footage crop percent"
              type="number"
              min={0}
              max={80}
              className="w-16 border"
              value={Math.round((1 - (item.crop?.width ?? 1)) * 100)}
              onChange={(e) => {
                const f =
                  Math.max(0, Math.min(80, Number(e.target.value))) / 100;
                onEdit({
                  type: "layer",
                  itemId: item.id,
                  changes: {
                    crop: f
                      ? { x: f / 2, y: f / 2, width: 1 - f, height: 1 - f }
                      : undefined,
                  },
                });
              }}
            />
          </label>
          <span className="text-muted-foreground">
            Render to inspect exact appearance.
          </span>
        </div>
      )}
      {active && (
        <p role="status">
          Export revision {active.inputRevision}: {active.stage}{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void action(() =>
                api(`/api/studio/projects/${document.id}/render`, {
                  method: "DELETE",
                  body: JSON.stringify({ workId: active.id }),
                }),
              )
            }
          >
            Cancel export
          </Button>
        </p>
      )}
      {!active && work.some((w) => w.error) && (
        <p className="text-sm text-destructive">
          {work.find((w) => w.error)?.error}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {artifact && (
        <>
          <select
            aria-label="Export history"
            value={artifact.id}
            onChange={(e) => setChosen(e.target.value)}
          >
            {artifacts.map((a) => (
              <option key={a.id} value={a.id}>
                Revision {a.revision} · {a.probe.width}×{a.probe.height} ·{" "}
                {a.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <NormalizedPreview
            artifact={{
              ...artifact,
              current: saved && artifact.revision === document.revision,
            }}
          />
          <a
            className="inline-block rounded border px-3 py-2 text-sm"
            href={`/api/studio/projects/${document.id}/render/${artifact.id}?checksum=${artifact.checksum}`}
            download
          >
            Download MP4
          </a>
          <Link
            className="ml-3 underline text-sm"
            href={`/thumbnails/new?source=${encodeURIComponent(JSON.stringify({ kind: "project", projectId: document.id, revision: artifact.revision, renderId: artifact.id, renderChecksum: artifact.checksum }))}`}
          >
            Thumbnail Studio
          </Link>
          <details className="space-y-2">
            <summary>Prepare publication review</summary>
            <p className="text-sm text-muted-foreground">
              Creates a local review draft. Approve it from the queue after
              checking the destination.
            </p>
            <select
              aria-label="Review destination"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              {["youtube", "instagram", "tiktok"].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <input
              aria-label="Publication text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Title or caption"
              className="border rounded p-2"
            />
            <Button
              disabled={
                !saved ||
                artifact.revision !== document.revision ||
                busy ||
                !text.trim()
              }
              onClick={() =>
                void action(async () => {
                  await api(
                    `/api/studio/projects/${document.id}/render/${artifact.id}/review`,
                    {
                      method: "POST",
                      body: JSON.stringify({
                        checksum: artifact.checksum,
                        platform,
                        text:
                          platform === "youtube"
                            ? { title: text }
                            : { caption: text },
                      }),
                    },
                  );
                  setReview(true);
                })
              }
            >
              Prepare review
            </Button>
            {review && (
              <Link href="/queue" className="underline">
                Open review queue
              </Link>
            )}
          </details>
        </>
      )}
    </section>
  );
}
