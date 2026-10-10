"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_DUCKING,
  audioRole,
  dbToGain,
  gainToDb,
  type AudioChanges,
} from "@/lib/studio/audio";
import type { EditOperation } from "@/lib/studio/operations";
import type {
  AssetRef,
  AudioRole,
  ProjectDocument,
  TimelineItem,
} from "@/lib/studio/types";
export function AudioPanel({
  document,
  item,
  assets,
  onEdit,
}: {
  document: ProjectDocument;
  item?: TimelineItem;
  assets: AssetRef[];
  onEdit: (op: EditOperation) => void;
}) {
  const asset = assets.find((a) => a.id === item?.assetId);
  if (
    !item ||
    !asset ||
    (asset.kind !== "audio" && !asset.streams?.some((s) => s.kind === "audio"))
  )
    return (
      <section
        aria-label="Audio inspector"
        className="rounded-xl border p-4 text-xs text-muted-foreground"
      >
        Select footage with audio or an imported sound to edit its mix. Import
        music, sound effects, and voiceover in the media library.
      </section>
    );
  const change = (changes: AudioChanges) =>
    onEdit({ type: "audio", itemId: item.id, changes });
  const duck = item.ducking ?? { ...DEFAULT_DUCKING, enabled: false };
  return (
    <section
      aria-label="Audio inspector"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">Audio</h2>
      {item.detachedAudioId ? (
        <>
          <p className="text-xs text-muted-foreground">
            Source audio is on its linked dialogue lane. Select it to adjust the
            mix.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onEdit({ type: "relink-audio", itemId: item.id })}
          >
            Relink source audio
          </Button>
        </>
      ) : (
        <>
          <label className="block text-xs">
            Sound role
            <select
              aria-label="Sound role"
              className="mt-1 w-full rounded border bg-background p-2"
              value={audioRole(document, item)}
              onChange={(e) =>
                change({ audioRole: e.target.value as AudioRole })
              }
            >
              {["dialogue", "music", "sfx", "voiceover"].map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            Gain (dB)
            <Input
              aria-label="Audio gain dB"
              type="number"
              min="-60"
              max="12"
              step="0.1"
              value={
                item.gain === 0
                  ? ""
                  : Math.round(gainToDb(item.gain ?? 1) * 100) / 100
              }
              placeholder="Silent"
              onChange={(e) =>
                change({
                  gain:
                    e.target.value === ""
                      ? 0
                      : dbToGain(Number(e.target.value)),
                })
              }
            />
          </label>
          <div className="flex flex-wrap gap-4 text-xs">
            {(["muted", "solo", "loop"] as const)
              .filter(
                (key) =>
                  key !== "loop" ||
                  (asset.kind === "audio" && !item.linkedVideoId),
              )
              .map((key) => (
                <label key={key}>
                  <input
                    aria-label={
                      key === "muted"
                        ? "Mute sound"
                        : key === "solo"
                          ? "Solo sound"
                          : "Loop sound"
                    }
                    type="checkbox"
                    checked={item[key] ?? false}
                    onChange={(e) => change({ [key]: e.target.checked })}
                  />{" "}
                  {key === "muted" ? "Mute" : key === "solo" ? "Solo" : "Loop"}
                </label>
              ))}
          </div>
          {asset.kind === "audio" && !item.linkedVideoId && (
            <label className="block text-xs">
              Sound duration (frames)
              <Input
                aria-label="Sound duration frames"
                type="number"
                min="1"
                value={item.durationFrames}
                onChange={(e) =>
                  onEdit({
                    type: "audio-duration",
                    itemId: item.id,
                    durationFrames: Number(e.target.value),
                  })
                }
              />
              <span className="text-[11px] text-muted-foreground">
                Enable looping to extend this sound. Turning it off restores the
                source duration.
              </span>
            </label>
          )}
          {(["fadeInFrames", "fadeOutFrames"] as const).map((key, index) => (
            <label key={key} className="block text-xs">
              {index ? "Fade out" : "Fade in"} (frames)
              <Input
                aria-label={
                  index ? "Audio fade out frames" : "Audio fade in frames"
                }
                type="number"
                min="0"
                max={item.durationFrames}
                value={item[key] ?? 0}
                onChange={(e) => change({ [key]: Number(e.target.value) })}
              />
            </label>
          ))}
          {audioRole(document, item) === "music" && (
            <fieldset className="space-y-2 border-t pt-3">
              <legend className="text-xs">Dialogue ducking</legend>
              <label className="text-xs">
                <input
                  aria-label="Duck music under dialogue"
                  type="checkbox"
                  checked={duck.enabled}
                  onChange={(e) =>
                    change({ ducking: { ...duck, enabled: e.target.checked } })
                  }
                />{" "}
                Lower music under dialogue
              </label>
              {(
                [
                  {
                    key: "reductionDb",
                    label: "Ducking reduction dB",
                    max: 60,
                  },
                  { key: "attackMs", label: "Ducking attack ms", max: 10000 },
                  { key: "releaseMs", label: "Ducking release ms", max: 10000 },
                ] as const
              ).map(({ key, label, max }) => (
                <label key={key} className="block text-xs">
                  {label}
                  <Input
                    aria-label={label}
                    type="number"
                    min="0"
                    max={max}
                    value={duck[key]}
                    onChange={(e) =>
                      change({
                        ducking: { ...duck, [key]: Number(e.target.value) },
                      })
                    }
                  />
                </label>
              ))}
            </fieldset>
          )}
          {item.linkedVideoId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onEdit({ type: "relink-audio", itemId: item.id })}
            >
              Relink source audio
            </Button>
          ) : (
            asset.kind === "video" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  onEdit({
                    type: "detach-audio",
                    itemId: item.id,
                    newId: crypto.randomUUID(),
                    trackId: "dialogue",
                  })
                }
              >
                Detach source audio
              </Button>
            )
          )}
        </>
      )}
      <p className="text-[11px] text-muted-foreground">
        Linked source audio follows footage trims and moves. The mix reserves
        headroom when sounds overlap.
      </p>
    </section>
  );
}
