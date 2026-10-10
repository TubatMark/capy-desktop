"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AssetRef } from "@/lib/studio/types";
import { api } from "@/hooks/use-job";
export function AssetBin({
  assets,
  onAdd,
  onRefresh,
}: {
  assets: AssetRef[];
  onAdd: (asset: AssetRef) => void;
  onRefresh: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const recoverLegacy = useRef<string | undefined>(undefined);
  const relink = useRef<string | undefined>(undefined);
  const [localPath, setLocalPath] = useState("");
  const [kind, setKind] = useState<AssetRef["kind"]>("video");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      const inferred = file.type.startsWith("audio/")
        ? "audio"
        : file.type.startsWith("image/")
          ? "image"
          : "video";
      form.set("kind", inferred);
      if (recoverLegacy.current) form.set("recoverLegacyId", recoverLegacy.current);
      if (relink.current) form.set("relinkId", relink.current);
      const response = await fetch("/api/studio/assets", {
        method: "POST",
        body: form,
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error ?? "Import failed");
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      relink.current = undefined;
      recoverLegacy.current = undefined;
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  async function importPath() {
    setBusy(true);
    setError("");
    try {
      await api("/api/studio/assets", {
        method: "POST",
        body: JSON.stringify({ path: localPath, kind }),
      });
      setLocalPath("");
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function retry(id: string, action = "retry") {
    setError("");
    try {
      await api("/api/studio/assets", {
        method: "PATCH",
        body: JSON.stringify({ id, action }),
      });
      onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <aside
      className="min-w-0 space-y-4 rounded-xl border bg-card p-4"
      aria-label="Asset library"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Media library</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            relink.current = undefined;
      recoverLegacy.current = undefined;
            fileRef.current?.click();
          }}
        >
          Import media
        </Button>
      </div>
      <input
        ref={fileRef}
        data-testid="media-upload"
        className="sr-only"
        type="file"
        accept="video/*,audio/*,image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <p className="text-xs text-muted-foreground">
        Your source files stay intact. Imported copies are prepared for smooth
        preview.
      </p>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Import a local path (large files)
        </summary>
        <div className="mt-3 space-y-2">
          <Input
            aria-label="Local media path"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="/Users/you/Movies/source.mp4"
          />
          <select
            aria-label="Media type"
            className="w-full rounded-md border bg-background p-2 text-xs"
            value={kind}
            onChange={(e) => setKind(e.target.value as AssetRef["kind"])}
          >
            <option value="video">Video</option>
            <option value="audio">Audio</option>
            <option value="image">Image</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={!localPath || busy}
            onClick={() => void importPath()}
          >
            Import path
          </Button>
        </div>
      </details>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <ul className="max-h-80 space-y-2 overflow-y-auto">
        {assets.map((asset) => (
          <li key={asset.id} className="rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium" title={asset.name}>
                  {asset.name ?? asset.id}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {asset.kind} ·{" "}
                  {asset.durationUs
                    ? `${(asset.durationUs / 1000000).toFixed(1)}s · `
                    : ""}
                  {asset.status}
                </p>
              </div>
              {asset.status === "ready" && !!asset.checksum && !!asset.mediaUrl && asset.kind !== "font" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onAdd(asset)}
                  aria-label={`Add ${asset.name ?? asset.id}`}
                >
                  Add
                </Button>
              ) : null}
            </div>
            {asset.legacy && !asset.checksum && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => {
                if (asset.status === "missing") {
                  recoverLegacy.current = asset.id;
                  relink.current = undefined;
                  fileRef.current?.click();
                } else void retry(asset.id, "adopt");
              }}>
                {asset.status === "missing" ? "Recover as new media" : "Prepare legacy media"}
              </Button>
            )}
            {asset.status === "failed" && !asset.legacy && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void retry(asset.id)}
              >
                Retry preparation
              </Button>
            )}
            {asset.error && (
              <p className="mt-1 text-xs text-destructive">{asset.error}</p>
            )}
            {["missing", "relink", "failed"].includes(asset.status) &&
              !!asset.checksum && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    relink.current = asset.id;
                    fileRef.current?.click();
                  }}
                >
                  Relink {asset.name ?? "media"}
                </Button>
              )}
          </li>
        ))}
      </ul>
      {!assets.length && (
        <p className="text-xs text-muted-foreground">
          Import your first video, image, or audio file.
        </p>
      )}
    </aside>
  );
}
