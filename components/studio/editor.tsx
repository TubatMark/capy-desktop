"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Copy,
  Scissors,
  Undo2,
  Redo2,
  Trash2,
  Play,
  Pause,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/hooks/use-job";
import { applyEdit, type EditOperation } from "@/lib/studio/operations";
import type { AssetRef, ProjectDocument } from "@/lib/studio/types";
import { DraftJournal, type RecoveryDraft } from "@/lib/studio/recovery";
import { AssetBin } from "./asset-bin";
import { Timeline } from "./timeline";
import { History } from "./history";
import { AudioPanel } from "./audio-panel";
import { CaptionsPanel } from "./captions-panel";
import { LayersPanel } from "./layers-panel";
import { AudioPreview } from "./audio-preview";
import { LayerPreview } from "./layer-preview";
type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";
export function StudioEditor({ id }: { id: string }) {
  const router = useRouter();
  const [document, setDocument] = useState<ProjectDocument>();
  const latest = useRef<ProjectDocument | undefined>(undefined);
  const [assets, setAssets] = useState<AssetRef[]>([]);
  const [history, setHistory] = useState<ProjectDocument[]>([]);
  const [selected, setSelected] = useState<string>();
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playhead = useRef(0);
  playhead.current = frame;
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const savedGeneration = useRef(0);
  const saving = useRef(false);
  const conflict = useRef(false);
  const editorId = useRef(crypto.randomUUID());
  const journal = useRef<DraftJournal | undefined>(undefined);
  const serverRevision = useRef(0);
  const [recoveryDrafts, setRecoveryDrafts] = useState<RecoveryDraft[]>([]);
  const undoStack = useRef<EditOperation[]>([]);
  const redoStack = useRef<EditOperation[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  const [trimIn, setTrimIn] = useState(0);
  const [trimOut, setTrimOut] = useState(0);
  const refreshAssets = useCallback(async () => {
    try {
      setAssets(await api("/api/studio/assets"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const load = useCallback(
    async (recover = true) => {
      const result = (await api(`/api/studio/projects/${id}`)) as {
        document: ProjectDocument;
        history: ProjectDocument[];
      };
      let doc = result.document;
      let recoveredKey: string | undefined;
      serverRevision.current = result.document.revision;
      if (!journal.current || journal.current.projectId !== id)
        journal.current = new DraftJournal(
          localStorage,
          sessionStorage,
          id,
          editorId.current,
        );
      conflict.current = false;
      setError("");
      setSaveState("saved");
      generation.current = 0;
      savedGeneration.current = 0;
      if (recover) {
        try {
          const recovery = journal.current.recover();
          if (recovery) {
            const draft = recovery.document;
            if (draft.id === id) {
              applyEdit(draft, { type: "restore", document: draft });
              recoveredKey = recovery.key;
              journal.current.adopt(recovery);
              doc = draft;
              generation.current = 1;
              setVersion((v) => v + 1);
              if (draft.revision !== result.document.revision) {
                conflict.current = true;
                setSaveState("conflict");
                setError(
                  "Recovered edits use an older revision. Save a copy or reload the newer project.",
                );
              } else setSaveState("unsaved");
            }
          }
        } catch {
          setError(
            "A recovery draft could not be read. The saved project is available.",
          );
        }
      }
      setRecoveryDrafts(
        journal.current.list().filter((draft) => draft.key !== recoveredKey),
      );
      latest.current = doc;
      setDocument(doc);
      setHistory(result.history);
      undoStack.current = [];
      redoStack.current = [];
      setSelected(doc.items[0]?.id);
    },
    [id],
  );
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    void refreshAssets();
    const timer = setInterval(() => void refreshAssets(), 2000);
    return () => clearInterval(timer);
  }, [load, refreshAssets]);
  const update = useCallback(
    (doc: ProjectDocument) => {
      latest.current = doc;
      setDocument(doc);
      generation.current++;
      setVersion((v) => v + 1);
      setSaveState(conflict.current ? "conflict" : "unsaved");
      try {
        journal.current?.write(doc);
      } catch {
        setError(
          "Browser recovery storage is full; keep this window open until saved.",
        );
      }
    },
    [id],
  );
  function recoverDraft(draft: RecoveryDraft) {
    try {
      journal.current?.adopt(draft);
      latest.current = draft.document;
      setDocument(draft.document);
      generation.current++;
      conflict.current = draft.document.revision !== serverRevision.current;
      setSaveState(conflict.current ? "conflict" : "unsaved");
      setError(
        conflict.current
          ? "Recovered edits use an older revision. Save a copy or reload the newer project."
          : "",
      );
      setSelected(draft.document.items[0]?.id);
      setVersion((version) => version + 1);
      setRecoveryDrafts(
        journal.current?.list().filter((other) => other.key !== draft.key) ??
          [],
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  const edit = useCallback(
    (op: EditOperation) => {
      if (!latest.current) return;
      try {
        const result = applyEdit(latest.current, op);
        undoStack.current.push(result.inverse);
        redoStack.current = [];
        update(result.document);
        setError("");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [update],
  );
  const undo = useCallback(() => {
    const op = undoStack.current.pop();
    if (!op || !latest.current) return;
    const result = applyEdit(latest.current, op);
    redoStack.current.push(result.inverse);
    update(result.document);
  }, [update]);
  const redo = useCallback(() => {
    const op = redoStack.current.pop();
    if (!op || !latest.current) return;
    const result = applyEdit(latest.current, op);
    undoStack.current.push(result.inverse);
    update(result.document);
  }, [update]);
  const save = useCallback(async () => {
    if (
      !latest.current ||
      saving.current ||
      conflict.current ||
      savedGeneration.current === generation.current
    )
      return;
    saving.current = true;
    setSaveState("saving");
    const pending = latest.current;
    const sentGeneration = generation.current;
    try {
      const response = await fetch(`/api/studio/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: pending,
          expectedRevision: pending.revision,
        }),
      });
      const result = await response.json();
      if (response.status === 409) {
        conflict.current = true;
        setSaveState("conflict");
        throw Error(
          "A newer revision was saved in another window. Save a copy of your edits or reload the newer project.",
        );
      }
      if (!response.ok) throw Error(result.error ?? "Save failed");
      savedGeneration.current = sentGeneration;
      const next = {
        ...latest.current,
        revision: result.revision,
        updatedAt: result.updatedAt,
      };
      serverRevision.current = result.revision;
      latest.current = next;
      setDocument(next);
      setHistory((h) => [result, ...h]);
      if (generation.current === sentGeneration) {
        setSaveState("saved");
        journal.current?.saved(pending);
        setRecoveryDrafts(journal.current?.list() ?? []);
      } else {
        setSaveState("unsaved");
        journal.current?.write(next);
        setVersion((v) => v + 1);
      }
    } catch (e) {
      if (!conflict.current) setSaveState("error");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      saving.current = false;
    }
  }, [id]);
  useEffect(() => {
    if (!version) return;
    const timer = setTimeout(() => void save(), 600);
    return () => clearTimeout(timer);
  }, [version, save]);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (generation.current !== savedGeneration.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, []);
  const item = document?.items.find((i) => i.id === selected);
  const active = document?.items.find(
    (i) =>
      document?.tracks.find((t) => t.id === i.trackId)?.kind === "video" &&
      document?.tracks.find((t) => t.id === i.trackId)?.role !== "overlay" &&
      frame >= i.startFrame &&
      frame < i.startFrame + i.durationFrames,
  );
  const asset = assets.find((a) => a.id === active?.assetId);
  const fps = document ? document.fps.numerator / document.fps.denominator : 30;
  const total = Math.max(
    0,
    ...(document?.items.map((i) => i.startFrame + i.durationFrames) ?? [0]),
  );
  useEffect(() => {
    setTrimIn(0);
    setTrimOut(item?.durationFrames ?? 0);
  }, [selected, item?.durationFrames]);
  useEffect(() => {
    if (!active || !video.current) return;
    const desired =
      (active.sourceInUs ?? 0) / 1000000 + (frame - active.startFrame) / fps;
    if (Math.abs(video.current.currentTime - desired) > 0.075)
      video.current.currentTime = desired;
    if (playing) void video.current.play().catch(() => setPlaying(false));
    else video.current.pause();
  }, [
    active?.id,
    active?.sourceInUs,
    active?.startFrame,
    asset?.proxyUrl,
    asset?.mediaUrl,
    frame,
    fps,
    playing,
  ]);
  useEffect(() => {
    if (!playing) return;
    let request = 0,
      lastTime = performance.now(),
      clockFrame = playhead.current,
      lastFrame = playhead.current;
    const tick = (time: number) => {
      if (playhead.current !== lastFrame) clockFrame = playhead.current;
      clockFrame += ((time - lastTime) * fps) / 1000;
      lastTime = time;
      lastFrame = Math.min(total, Math.floor(clockFrame));
      setFrame(lastFrame);
      if (lastFrame >= total) {
        setPlaying(false);
        return;
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, fps, total]);
  const split = useCallback(() => {
    const doc = latest.current;
    const current = doc?.items.find((i) => i.id === selected);
    if (!current) return;
    edit({
      type: "split",
      itemId: current.id,
      frame: frame - current.startFrame,
      newId: crypto.randomUUID(),
    });
  }, [selected, frame, edit]);
  const togglePlay = useCallback(() => {
    if (playing) {
      video.current?.pause();
      setPlaying(false);
    } else {
      if (frame >= total) setFrame(0);
      setPlaying(true);
    }
  }, [playing, frame, total]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "s") {
          e.preventDefault();
          void save();
        }
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        split();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        edit({
          type: e.shiftKey ? "ripple-delete" : "remove",
          itemId: selected,
        });
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setFrame((f) =>
          Math.max(0, Math.min(total, f + (e.key === "ArrowRight" ? 1 : -1))),
        );
      } else if (e.key.toLowerCase() === "i" && item)
        setTrimIn(Math.max(0, frame - item.startFrame));
      else if (e.key.toLowerCase() === "o" && item)
        setTrimOut(Math.min(item.durationFrames, frame - item.startFrame));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [redo, undo, save, togglePlay, split, selected, edit, total, item, frame]);
  async function copyProject() {
    if (!latest.current) return;
    try {
      const blank = (await api("/api/studio/projects", {
        method: "POST",
        body: JSON.stringify({
          name: `${latest.current.name ?? "Project"} copy`,
        }),
      })) as ProjectDocument;
      const copy = {
        ...latest.current,
        id: blank.id,
        revision: blank.revision,
        createdAt: blank.createdAt,
        name: blank.name,
      };
      await api(`/api/studio/projects/${copy.id}`, {
        method: "PUT",
        body: JSON.stringify({
          document: copy,
          expectedRevision: copy.revision,
        }),
      });
      router.push(`/studio/${copy.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function addAsset(a: AssetRef) {
    if (!latest.current || a.kind === "font") return;
    const durationUs = a.durationUs ?? 3000000;
    const duration = Math.max(1, Math.round((durationUs * fps) / 1000000));
    const trackId = a.kind === "audio" ? "audio" : "video";
    const start = Math.max(
      0,
      ...latest.current.items
        .filter((i) => i.trackId === trackId)
        .map((i) => i.startFrame + i.durationFrames),
    );
    const newId = crypto.randomUUID();
    edit({
      type: "add-asset",
      item: {
        id: newId,
        assetId: a.id,
        trackId,
        startFrame: start,
        durationFrames: duration,
        sourceInUs: 0,
        sourceOutUs: durationUs,
        ...(a.kind === "audio" ? { audioRole: "music" as const } : {}),
        speed: 1,
      },
    });
    setSelected(newId);
  }
  function reorder(direction: number) {
    if (!document || !selected) return;
    const ids = document.items.map((i) => i.id);
    const index = ids.indexOf(selected);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    edit({ type: "reorder", itemIds: ids });
  }
  if (!document)
    return (
      <div className="p-8">
        <p>{error || "Opening Studio…"}</p>
        <Link href="/studio" className="text-sm text-primary">
          Back to Studio
        </Link>
      </div>
    );
  return (
    <div className="min-w-0 space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <Link
          href="/studio"
          aria-label="Back to Studio"
          className="rounded-md p-2 hover:bg-accent"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <Input
          aria-label="Project name"
          className="max-w-xs font-semibold"
          value={document.name ?? "Untitled project"}
          onChange={(e) => update({ ...document, name: e.target.value })}
        />
        <span
          role="status"
          data-testid="save-status"
          className="text-xs text-muted-foreground"
        >
          {saveState === "saved"
            ? `Saved · revision ${document.revision}`
            : saveState === "conflict"
              ? "Save conflict"
              : saveState === "saving"
                ? "Saving…"
                : saveState === "error"
                  ? "Save failed"
                  : "Unsaved changes"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={undo}
            disabled={!undoStack.current.length}
            aria-label="Undo"
          >
            <Undo2 />
            Undo
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={redo}
            disabled={!redoStack.current.length}
            aria-label="Redo"
          >
            <Redo2 />
            Redo
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyProject()}
          >
            <Copy />
            Save a copy
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void save()}
            disabled={saveState === "saved" || saveState === "conflict"}
          >
            Save now
          </Button>
        </div>
      </header>
      {!!recoveryDrafts.length && (
        <details className="rounded-lg border bg-card p-3">
          <summary className="cursor-pointer text-sm">
            Recoverable edits from other windows · {recoveryDrafts.length}
          </summary>
          <div className="mt-3 flex flex-wrap gap-2">
            {recoveryDrafts.map((draft) => (
              <Button
                key={draft.key}
                variant="outline"
                size="sm"
                onClick={() => recoverDraft(draft)}
              >
                Recover {draft.document.name ?? "Untitled project"}
              </Button>
            ))}
          </div>
        </details>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <p>{error}</p>
          {saveState === "conflict" && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                journal.current?.discard();
                void load(false);
              }}
            >
              Reload newer revision
            </Button>
          )}
        </div>
      )}
      <div className="grid items-start gap-5 xl:grid-cols-[280px_minmax(0,1fr)_260px]">
        <AssetBin
          assets={assets}
          onAdd={addAsset}
          onRefresh={() => void refreshAssets()}
        />
        <section
          className="min-w-0 rounded-xl border bg-card p-4"
          aria-label="Preview"
        >
          <AudioPreview
            document={document}
            assets={assets}
            frame={frame}
            playing={playing}
          />
          <div
            className="relative mx-auto flex max-h-[400px] items-center justify-center overflow-hidden rounded-lg bg-black"
            style={{
              aspectRatio: `${document.canvas.width}/${document.canvas.height}`,
              maxWidth: 400,
              containerType: "inline-size",
            }}
          >
            {asset?.status === "ready" && active ? (
              asset.kind === "image" ? (
                <img
                  src={asset.mediaUrl}
                  alt={asset.name ?? "Preview"}
                  className="h-full w-full object-contain"
                  style={
                    active.transform
                      ? {
                          transform: `translate(${(active.transform.x / document.canvas.width) * 100}%, ${(active.transform.y / document.canvas.height) * 100}%) scale(${active.transform.scale}) rotate(${active.transform.rotation}deg)`,
                        }
                      : undefined
                  }
                />
              ) : (
                <video
                  key={asset.id}
                  ref={video}
                  src={asset.proxyUrl ?? asset.mediaUrl}
                  className="h-full w-full object-contain"
                  style={
                    active.transform
                      ? {
                          transform: `translate(${(active.transform.x / document.canvas.width) * 100}%, ${(active.transform.y / document.canvas.height) * 100}%) scale(${active.transform.scale}) rotate(${active.transform.rotation}deg)`,
                        }
                      : undefined
                  }
                  muted
                  playsInline
                  onLoadedMetadata={() => {
                    if (video.current && active)
                      video.current.currentTime =
                        (active.sourceInUs ?? 0) / 1000000 +
                        (frame - active.startFrame) / fps;
                  }}
                />
              )
            ) : (
              <p className="px-5 text-center text-sm text-white/60">
                {active
                  ? asset?.status === "waiting"
                    ? "Requested source footage is waiting for the worker."
                    : `Media ${asset?.status ?? "loading"}. ${asset?.error ?? ""}`
                  : "Select footage or import media to start editing."}
              </p>
            )}
            <LayerPreview
              document={document}
              assets={assets}
              frame={frame}
              playing={playing}
              main={active}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFrame((f) => Math.max(0, f - 1))}
              aria-label="Previous frame"
            >
              −1 frame
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={togglePlay}
              disabled={!total}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause /> : <Play />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFrame((f) => Math.min(total, f + 1))}
              aria-label="Next frame"
            >
              +1 frame
            </Button>
            <label className="flex items-center gap-2 text-xs">
              Playhead
              <Input
                aria-label="Playhead frame"
                type="number"
                min="0"
                max={total}
                className="w-24"
                value={frame}
                onChange={(e) =>
                  setFrame(Math.max(0, Math.min(total, Number(e.target.value))))
                }
              />
            </label>
            <span className="font-mono text-xs text-muted-foreground">
              {(frame / fps).toFixed(2)} / {(total / fps).toFixed(2)}s
            </span>
          </div>
        </section>
        <section
          className="space-y-4 rounded-xl border bg-card p-4"
          aria-label="Clip inspector"
        >
          <h2 className="text-sm font-semibold">Selected clip</h2>
          {item ? (
            <>
              <p className="truncate text-xs text-muted-foreground">
                {assets.find((a) => a.id === item.assetId)?.name ?? item.id}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={split}
                  disabled={
                    frame <= item.startFrame ||
                    frame >= item.startFrame + item.durationFrames
                  }
                >
                  <Scissors />
                  Split
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    edit({
                      type: "duplicate",
                      itemId: item.id,
                      newId: crypto.randomUUID(),
                    })
                  }
                >
                  Duplicate
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => edit({ type: "remove", itemId: item.id })}
                >
                  <Trash2 />
                  Delete
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    edit({ type: "ripple-delete", itemId: item.id })
                  }
                >
                  Ripple delete
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs">
                  Trim in (frames)
                  <Input
                    aria-label="Trim in frames"
                    type="number"
                    min="0"
                    value={trimIn}
                    onChange={(e) => setTrimIn(Number(e.target.value))}
                  />
                </label>
                <label className="text-xs">
                  Trim out (frames)
                  <Input
                    aria-label="Trim out frames"
                    type="number"
                    value={trimOut}
                    onChange={(e) => setTrimOut(Number(e.target.value))}
                  />
                </label>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  edit({
                    type: "trim",
                    itemId: item.id,
                    inFrame: trimIn,
                    outFrame: trimOut,
                  })
                }
              >
                Apply trim
              </Button>
              <label className="block text-xs">
                Start frame
                <Input
                  aria-label="Clip start frame"
                  type="number"
                  min="0"
                  value={item.startFrame}
                  onChange={(e) =>
                    edit({
                      type: "move",
                      itemId: item.id,
                      startFrame: Number(e.target.value),
                    })
                  }
                />
              </label>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => reorder(-1)}>
                  Move earlier
                </Button>
                <Button size="sm" variant="outline" onClick={() => reorder(1)}>
                  Move later
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {item.durationFrames} frames. Source{" "}
                {(item.sourceInUs ?? 0) / 1000000}s–
                {(item.sourceOutUs ?? 0) / 1000000}s. Originals are preserved.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Select a clip on the timeline.
            </p>
          )}
        </section>
      </div>
      <Timeline
        document={document}
        assets={assets}
        selected={selected}
        frame={frame}
        onSelect={setSelected}
        onFrame={setFrame}
        onEdit={edit}
      />
      <div className="grid items-start gap-5 lg:grid-cols-3">
        <AudioPanel
          document={document}
          item={item}
          assets={assets}
          onEdit={edit}
        />
        <CaptionsPanel
          document={document}
          frame={frame}
          onFrame={setFrame}
          onEdit={edit}
        />
        <LayersPanel
          document={document}
          item={item}
          assets={assets}
          frame={frame}
          onEdit={edit}
          onSelect={setSelected}
        />
      </div>
      <History
        entries={history}
        onRestore={(doc) => edit({ type: "restore", document: doc })}
      />
    </div>
  );
}
