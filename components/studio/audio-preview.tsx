"use client";
import { useEffect, useMemo, useRef } from "react";
import type { AssetRef, ProjectDocument } from "@/lib/studio/types";
import { sourceTimeUs } from "@/lib/studio/audio";
import { audioGainAtFrame, buildAudioPlan } from "@/src/studio/audio-plan";
/** Browser audition of the canonical mix; B4 owns deterministic normalized export. */
export function AudioPreview({
  document,
  assets,
  frame,
  playing,
}: {
  document: ProjectDocument;
  assets: AssetRef[];
  frame: number;
  playing: boolean;
}) {
  const elements = useRef(new Map<string, HTMLAudioElement>());
  const plan = useMemo(
    () => buildAudioPlan(document, assets),
    [document, assets],
  );
  useEffect(() => {
    for (const clip of plan.clips) {
      const media = elements.current.get(clip.itemId),
        item = document.items.find((i) => i.id === clip.itemId);
      if (!media || !item) continue;
      const gain = audioGainAtFrame(plan, clip.itemId, frame);
      media.playbackRate = item.speed;
      media.preservesPitch = true;
      media.volume = Math.min(1, gain);
      const inRange =
        clip.enabled &&
        frame >= clip.startFrame &&
        frame < clip.startFrame + clip.durationFrames;
      if (!inRange) {
        media.pause();
        continue;
      }
      const desired = sourceTimeUs(item, frame, document) / 1000000;
      if (Math.abs(media.currentTime - desired) > 0.05)
        media.currentTime = desired;
      if (playing && media.paused) void media.play().catch(() => {});
      else if (!playing) media.pause();
    }
  }, [document, frame, playing, plan]);
  return (
    <div hidden aria-hidden="true">
      {plan.clips.map((clip) => {
        const asset = assets.find((a) => a.id === clip.assetId)!;
        return (
          <audio
            key={clip.itemId}
            data-testid="studio-audio-preview"
            data-item-id={clip.itemId}
            ref={(element) => {
              if (element) elements.current.set(clip.itemId, element);
              else elements.current.delete(clip.itemId);
            }}
            preload="auto"
            src={asset.mediaUrl}
          />
        );
      })}
    </div>
  );
}
