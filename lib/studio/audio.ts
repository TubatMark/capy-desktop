import type {
  AudioRole,
  ExactUs,
  DuckingSettings,
  ProjectDocument,
  TimelineItem,
} from "./types";
import {
  addUs,
  frameTimeUs,
  integerUs,
  moduloUs,
  numberUs,
  subtractUs,
  floorUs,
  scaleUs,
} from "./time";
export const DEFAULT_DUCKING: DuckingSettings = {
  enabled: true,
  reductionDb: 12,
  attackMs: 100,
  releaseMs: 300,
};
export type AudioChanges = Pick<
  TimelineItem,
  | "gain"
  | "muted"
  | "solo"
  | "loop"
  | "audioRole"
  | "fadeInFrames"
  | "fadeOutFrames"
  | "ducking"
>;
export function audioRole(doc: ProjectDocument, item: TimelineItem): AudioRole {
  const track = doc.tracks.find((t) => t.id === item.trackId);
  return (
    item.audioRole ??
    (track?.role &&
    ["dialogue", "music", "sfx", "voiceover"].includes(track.role)
      ? (track.role as AudioRole)
      : track?.kind === "video"
        ? "dialogue"
        : "music")
  );
}
export function sourcePhaseUs(item: TimelineItem): ExactUs {
  return addUs(
    item.sourcePhaseUs ?? integerUs(0),
    integerUs(item.loop ? (item.loopOffsetUs ?? 0) : 0),
  );
}
export function sourceFrameTimeUs(
  item: TimelineItem,
  frame: number,
  doc: Pick<ProjectDocument, "fps">,
): ExactUs {
  if (item.freeze) return integerUs(item.freeze.sourceUs);
  const elapsed = scaleUs(
    frameTimeUs(Math.max(0, frame - item.startFrame), doc),
    item.speed,
  );
  const offset = addUs(sourcePhaseUs(item), elapsed);
  return addUs(
    integerUs(item.sourceInUs!),
    item.loop
      ? moduloUs(offset, integerUs(item.sourceOutUs! - item.sourceInUs!))
      : offset,
  );
}
/** Keep the exact phase; source bytes remain bounded by integer microsecond metadata. */
export function advanceSourceStart(
  item: TimelineItem,
  frames: number,
  doc: Pick<ProjectDocument, "fps">,
) {
  const position = sourceFrameTimeUs(item, item.startFrame + frames, doc);
  if (item.loop) {
    item.sourcePhaseUs = subtractUs(position, integerUs(item.sourceInUs!));
    delete item.loopOffsetUs;
  } else {
    item.sourceInUs = floorUs(position);
    item.sourcePhaseUs = subtractUs(position, integerUs(item.sourceInUs));
  }
}
export function sourceTimeUs(
  item: TimelineItem,
  frame: number,
  doc: Pick<ProjectDocument, "fps">,
) {
  if (Number.isSafeInteger(frame))
    return numberUs(sourceFrameTimeUs(item, frame, doc));
  if (item.freeze) return item.freeze.sourceUs;
  const elapsed =
    (item.speed *
      (Math.max(0, frame - item.startFrame) * 1000000 * doc.fps.denominator)) /
    doc.fps.numerator;
  const offset = numberUs(sourcePhaseUs(item)) + elapsed;
  return (
    item.sourceInUs! +
    (item.loop ? offset % (item.sourceOutUs! - item.sourceInUs!) : offset)
  );
}
/** Peak absolute samples from decoded bytes, independent of viewport and timeline zoom. */
export function waveformPeaks(channels: Float32Array[], bins = 96): number[] {
  const length = Math.max(0, ...channels.map((c) => c.length));
  return Array.from({ length: bins }, (_, bin) => {
    let peak = 0;
    const start = Math.floor((bin * length) / bins),
      end = Math.floor(((bin + 1) * length) / bins);
    for (const channel of channels)
      for (let i = start; i < end; i++)
        peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    return peak;
  });
}

export function dbToGain(db: number) {
  return 10 ** (db / 20);
}
export function gainToDb(gain: number) {
  return gain === 0 ? -Infinity : 20 * Math.log10(gain);
}
