import type {
  AssetRef,
  DuckingSettings,
  ProjectDocument,
} from "../../lib/studio/types";
import { audioRole } from "../../lib/studio/audio";
export interface AudioSegment {
  startFrame: number;
  durationFrames: number;
  sourceInUs: number;
  sourceOutUs: number;
}
export interface AudioClipPlan {
  itemId: string;
  assetId: string;
  role: string;
  enabled: boolean;
  startFrame: number;
  durationFrames: number;
  gain: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  transitionInFrames: number;
  transitionOutFrames: number;
  segments: AudioSegment[];
  ducking?: DuckingSettings;
}
export interface AudioPlan {
  projectId: string;
  revision: number;
  fps: ProjectDocument["fps"];
  frameCount: number;
  clips: AudioClipPlan[];
  dialogue: { startFrame: number; endFrame: number }[];
  /** Conservative sum-of-peaks headroom, shared by preview and export. */
  masterGain: number;
}
export function buildAudioPlan(
  doc: ProjectDocument,
  assets: AssetRef[],
): AudioPlan {
  const solo = doc.items.some((i) => i.solo) || doc.tracks.some((t) => t.solo);
  const clips: AudioClipPlan[] = [];
  const fps = doc.fps.numerator / doc.fps.denominator;
  for (const item of doc.items) {
    const asset = assets.find((a) => a.id === item.assetId),
      track = doc.tracks.find((t) => t.id === item.trackId);
    if (
      !asset ||
      (asset.kind !== "audio" &&
        !asset.streams?.some((s) => s.kind === "audio")) ||
      item.detachedAudioId
    )
      continue;
    const enabled =
      asset.status === "ready" &&
      !item.muted &&
      !track?.muted &&
      (!solo || !!item.solo || !!track?.solo);
    const span = item.sourceOutUs! - item.sourceInUs!;
    const segments: AudioSegment[] = [];
    let elapsed = 0,
      offset = item.loopOffsetUs ?? 0;
    while (elapsed < item.durationFrames) {
      const available = Math.max(
        1,
        Math.round(((span - offset) * fps) / 1000000),
      );
      const count = Math.min(item.durationFrames - elapsed, available);
      const sourceInUs = item.sourceInUs! + offset;
      segments.push({
        startFrame: item.startFrame + elapsed,
        durationFrames: count,
        sourceInUs,
        sourceOutUs: Math.min(
          item.sourceOutUs!,
          sourceInUs + Math.round((count * 1000000) / fps),
        ),
      });
      elapsed += count;
      offset = 0;
      if (!item.loop) break;
    }
    const video = item.linkedVideoId
      ? doc.items.find((v) => v.id === item.linkedVideoId)
      : item;
    const previous = video
      ? doc.items.find(
          (v) =>
            v.trackId === video.trackId &&
            v.transitionOut &&
            v.startFrame + v.durationFrames - v.transitionOut.durationFrames ===
              video.startFrame,
        )
      : undefined;
    clips.push({
      itemId: item.id,
      assetId: asset.id,
      role: audioRole(doc, item),
      enabled,
      startFrame: item.startFrame,
      durationFrames: item.durationFrames,
      gain: item.gain ?? 1,
      fadeInFrames: item.fadeInFrames ?? 0,
      fadeOutFrames: item.fadeOutFrames ?? 0,
      transitionInFrames: previous?.transitionOut?.durationFrames ?? 0,
      transitionOutFrames: video?.transitionOut?.durationFrames ?? 0,
      segments,
      ducking: item.ducking,
    });
  }
  const dialogue = clips
    .filter((c) => c.enabled && ["dialogue", "voiceover"].includes(c.role))
    .map((c) => ({
      startFrame: c.startFrame,
      endFrame: c.startFrame + c.durationFrames,
    }));
  // A project-wide headroom factor uses the largest sum of overlapping clip gains.
  const edges = [
    ...new Set(
      clips.flatMap((c) => [c.startFrame, c.startFrame + c.durationFrames]),
    ),
  ];
  const peak = Math.max(
    1,
    ...edges.map((frame) =>
      clips
        .filter(
          (c) =>
            c.enabled &&
            frame >= c.startFrame &&
            frame < c.startFrame + c.durationFrames,
        )
        .reduce((sum, c) => sum + c.gain, 0),
    ),
  );
  return {
    projectId: doc.id,
    revision: doc.revision,
    fps: doc.fps,
    frameCount: Math.max(
      0,
      ...doc.items.map((i) => i.startFrame + i.durationFrames),
    ),
    clips,
    dialogue,
    masterGain: 1 / peak,
  };
}
/** Piecewise-linear envelope in project frames; fractional frames preserve 100/300ms ramps. */
export function audioGainAtFrame(
  plan: AudioPlan,
  itemId: string,
  frame: number,
): number {
  const clip = plan.clips.find((c) => c.itemId === itemId);
  if (
    !clip?.enabled ||
    frame < clip.startFrame ||
    frame >= clip.startFrame + clip.durationFrames
  )
    return 0;
  const local = frame - clip.startFrame;
  let envelope = Math.min(
    1,
    clip.fadeInFrames ? local / clip.fadeInFrames : 1,
    clip.fadeOutFrames ? (clip.durationFrames - local) / clip.fadeOutFrames : 1,
  );
  envelope *= Math.min(
    1,
    clip.transitionInFrames ? local / clip.transitionInFrames : 1,
    clip.transitionOutFrames
      ? (clip.durationFrames - local) / clip.transitionOutFrames
      : 1,
  );
  const duck = clip.ducking;
  if (duck?.enabled && clip.role === "music") {
    const fps = plan.fps.numerator / plan.fps.denominator;
    const attack = (duck.attackMs * fps) / 1000,
      release = (duck.releaseMs * fps) / 1000,
      target = 10 ** (-duck.reductionDb / 20);
    let reduction = 1;
    for (const speech of plan.dialogue) {
      let amount = 0;
      if (frame >= speech.startFrame && frame < speech.endFrame) amount = 1;
      else if (
        attack &&
        frame >= speech.startFrame - attack &&
        frame < speech.startFrame
      )
        amount = (frame - (speech.startFrame - attack)) / attack;
      else if (
        release &&
        frame >= speech.endFrame &&
        frame < speech.endFrame + release
      )
        amount = 1 - (frame - speech.endFrame) / release;
      reduction = Math.min(reduction, 1 - amount * (1 - target));
    }
    envelope *= reduction;
  }
  return Math.max(0, clip.gain * envelope * plan.masterGain);
}
