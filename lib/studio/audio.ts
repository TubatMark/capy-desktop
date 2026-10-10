import type {
  AudioRole,
  DuckingSettings,
  ProjectDocument,
  TimelineItem,
} from "./types";
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
export function sourceTimeUs(
  item: TimelineItem,
  frame: number,
  doc: Pick<ProjectDocument, "fps">,
) {
  const elapsed =
    ((frame - item.startFrame) * 1000000 * doc.fps.denominator) /
    doc.fps.numerator;
  const span = item.sourceOutUs! - item.sourceInUs!;
  return (
    item.sourceInUs! +
    (item.loop
      ? (Math.max(0, elapsed) + (item.loopOffsetUs ?? 0)) % span
      : Math.max(0, elapsed))
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
