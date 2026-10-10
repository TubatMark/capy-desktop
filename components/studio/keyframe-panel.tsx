"use client";
import { useEffect, useRef, useState } from "react";
import type {
  AssetRef,
  ProjectDocument,
  TimelineItem,
} from "@/lib/studio/types";
import type { EditOperation } from "@/lib/studio/operations";
import { motionAtFrame } from "@/lib/studio/templates";
import {
  speakerSourceFingerprint,
  type SpeakerRegion,
} from "@/src/studio/reframe";
import { applyBoundSuggestions } from "@/lib/studio/retiming";
export function KeyframePanel({
  document,
  item,
  asset,
  frame,
  onEdit,
}: {
  document: ProjectDocument;
  item?: TimelineItem;
  asset?: AssetRef;
  frame: number;
  onEdit: (op: EditOperation) => void;
}) {
  const [proposal, setProposal] = useState<EditOperation[]>([]),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [fit, setFit] = useState<"contain" | "cover">("contain"),
    [confirmation, setConfirmation] = useState<{
      fingerprint: string;
      evidence: SpeakerRegion;
    }>(),
    [region, setRegion] = useState({ x: 0.25, y: 0, width: 0.5, height: 1 });
  const inputEpoch = useRef(0);
  function invalidateProposal() {
    inputEpoch.current++;
    setProposal([]);
    setStatus("");
    setBusy(false);
  }
  const fingerprint = speakerSourceFingerprint(item, asset);
  const speaker = confirmation?.fingerprint === fingerprint;
  useEffect(() => {
    setConfirmation(undefined);
    invalidateProposal();
  }, [fingerprint, document]);
  const local = item
    ? Math.max(0, Math.min(item.durationFrames - 1, frame - item.startFrame))
    : 0;
  const transform = item
    ? motionAtFrame(item, frame)
    : { x: 0, y: 0, scale: 1, rotation: 0 };
  async function suggest(kind: "silence" | "reframe") {
    if (!item) return;
    const epoch = ++inputEpoch.current;
    setBusy(true);
    setProposal([]);
    setStatus("Analyzing selected item locally…");
    try {
      const response = await fetch(
        `/api/studio/projects/${document.id}/suggestions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseRevision: document.revision,
            baseDocument: JSON.stringify(document),
            selectedItemIds: [item.id],
            kind,
            fit,
            ...(kind === "reframe" && speaker && asset
              ? {
                  speakerRegions: {
                    [item.id]: confirmation!.evidence,
                  },
                }
              : {}),
          }),
        },
      );
      const result = await response.json();
      if (epoch !== inputEpoch.current) return;
      if (!response.ok) throw Error(result.error);
      setProposal(result.operations);
      setStatus(
        result.operations[0]?.explanation ??
          "No leading or trailing silence of at least 250 ms below −40 dB was found.",
      );
    } catch (e) {
      if (epoch === inputEpoch.current) setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      if (epoch === inputEpoch.current) setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 rounded-xl border p-4"
      aria-label="Advanced editing"
    >
      <h2 className="font-semibold">Advanced editing</h2>
      {item ? (
        <>
          <p className="text-xs">
            Selected: {asset?.name ?? item.text?.value ?? item.id} · changes
            affect this item only.
          </p>
          {item.assetId && (
            <>
              <label className="block text-sm">
                Playback speed
                <select
                  aria-label="Playback speed"
                  className="ml-2 rounded border p-1"
                  value={item.speed}
                  disabled={!!item.freeze}
                  onChange={(e) =>
                    onEdit({
                      type: "retime",
                      itemId: item.id,
                      speed: Number(e.target.value),
                    })
                  }
                >
                  <option value="0.5">0.5×</option>
                  <option value="1">1×</option>
                  <option value="2">2×</option>
                </select>
              </label>
              <button
                disabled={asset?.kind === "audio"}
                className="rounded border px-2 py-1"
                onClick={() =>
                  onEdit({
                    type: "freeze",
                    itemId: item.id,
                    frame: local,
                    durationFrames: Math.round(
                      (document.fps.numerator / document.fps.denominator) * 2,
                    ),
                    audioPolicy: "silence",
                  })
                }
              >
                Freeze at playhead · 2 seconds · silence
              </button>
              <p className="text-xs text-muted-foreground">
                Speed preserves pitch and remaps source words. Duration changes
                leave other clips in place. Freeze holds this frame with silent
                source audio; Undo restores it. Invalid crossfades are cleared.
              </p>
            </>
          )}
          <div className="grid grid-cols-2 gap-2">
            {(["x", "y", "scale", "rotation"] as const).map((key) => (
              <label key={key} className="text-xs">
                Keyframe {key}
                <input
                  className="block w-full rounded border p-1"
                  aria-label={`Keyframe ${key}`}
                  disabled={asset?.kind === "audio"}
                  type="number"
                  step={key === "scale" ? 0.1 : 1}
                  value={transform[key]}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (!Number.isFinite(value)) return;
                    const keys = [
                      ...(item.keyframes ?? []).filter(
                        (k) => k.frame !== local,
                      ),
                      { frame: local, ...transform, [key]: value },
                    ].sort((a, b) => a.frame - b.frame);
                    onEdit({
                      type: "keyframes",
                      itemId: item.id,
                      keyframes: keys,
                    });
                  }}
                />
              </label>
            ))}
          </div>
          <button
            className="rounded border px-2 py-1"
            onClick={() =>
              onEdit({ type: "keyframes", itemId: item.id, keyframes: [] })
            }
          >
            Remove motion keyframes
          </button>
          <p className="text-xs">
            {item.keyframes?.length ?? 0} linear keys · local frame {local}
          </p>
          {item.assetId && (
            <>
              <label className="block text-sm">
                Reframe fallback
                <select
                  aria-label="Reframe fallback"
                  className="ml-2 rounded border p-1"
                  value={fit}
                  onChange={(e) => { invalidateProposal(); setFit(e.target.value as typeof fit); }}
                >
                  <option value="contain">Fit</option>
                  <option value="cover">Fill</option>
                </select>
              </label>
              <label className="block text-xs">
                <input
                  type="checkbox"
                  checked={speaker}
                  onChange={(e) => {
                    invalidateProposal();
                    setConfirmation(
                      e.target.checked && asset
                        ? {
                            fingerprint,
                            evidence: {
                              sourceChecksum: asset.checksum,
                              confirmedByUser: true,
                              startUs: item.sourceInUs!,
                              endUs: item.sourceOutUs!,
                              crop: structuredClone(region),
                            },
                          }
                        : undefined,
                    );
                  }}
                />{" "}
                I confirmed a speaker region for this entire source span
              </label>
              {
                <div className="grid grid-cols-2 gap-2">
                  {(["x", "y", "width", "height"] as const).map((k) => (
                    <label className="text-xs" key={k}>
                      Speaker region {k}
                      <input
                        aria-label={`Speaker region ${k}`}
                        className="w-full rounded border p-1"
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={region[k]}
                        onChange={(e) => {
                          invalidateProposal();
                          setRegion({ ...region, [k]: Number(e.target.value) });
                          setConfirmation(undefined);
                        }}
                      />
                    </label>
                  ))}
                </div>
              }
              <p className="text-xs text-muted-foreground">
                Speaker crops use your confirmed region and source checksum.
                Automatic speaker recognition is unavailable. Split at speaker
                changes before selecting a region.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={busy}
                  className="rounded border p-2"
                  onClick={() => void suggest("reframe")}
                >
                  Suggest reframe
                </button>
                <button
                  disabled={busy}
                  className="rounded border p-2"
                  onClick={() => void suggest("silence")}
                >
                  Suggest silence trim
                </button>
              </div>
            </>
          )}
          {proposal.length > 0 && (
            <>
              <p className="text-xs">
                Preview:{" "}
                {proposal[0]?.type === "suggested"
                  ? proposal[0].operations.map((o) => o.type).join(", ")
                  : ""}
                . Selected item only; original media is preserved.
              </p>
              <button
                className="rounded border p-2"
                onClick={() => {
                  try {
                    applyBoundSuggestions(document, proposal, [item.id]);
                    onEdit(proposal[0]!);
                    setProposal([]);
                    setStatus(
                      "Suggestion applied. Undo restores the original edit.",
                    );
                  } catch (e) {
                    setStatus(String(e));
                  }
                }}
              >
                Accept suggested edit
              </button>
              <button
                className="ml-2 rounded border p-2"
                onClick={() => setProposal([])}
              >
                Dismiss suggestion
              </button>
            </>
          )}
        </>
      ) : (
        <p className="text-sm">
          Select an item to edit speed, motion or framing.
        </p>
      )}
      <button
        className="rounded border px-2 py-1"
        onClick={() =>
          onEdit({
            type: "beat-marker",
            frame,
            label: `Beat ${1 + (document.beatMarkers?.length ?? 0)}`,
          })
        }
      >
        Add beat marker at playhead
      </button>
      {status && (
        <p role="status" className="text-xs">
          {status}
        </p>
      )}
    </section>
  );
}
