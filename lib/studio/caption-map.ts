import type { CaptionCue, ProjectDocument, SourceWords } from "./types";

/** Map each source occurrence independently; never key repeated footage by asset alone. */
export function mapCaptionCues(
  doc: ProjectDocument,
  words: SourceWords[],
): CaptionCue[] {
  const fps = doc.fps.numerator / doc.fps.denominator;
  const cues: CaptionCue[] = doc.captionCues
    .filter((c) => !c.source)
    .map((c) => structuredClone(c));
  for (const item of doc.items) {
    const track = doc.tracks.find((t) => t.id === item.trackId);
    if (
      track?.kind !== "video" ||
      track.role === "overlay" ||
      !item.assetId ||
      item.sourceInUs === undefined
    )
      continue;
    const source = words.find((w) => w.assetId === item.assetId);
    for (const word of source?.words ?? []) {
      if (word.endUs <= item.sourceInUs || word.startUs >= item.sourceOutUs!)
        continue;
      const id = `caption:${item.id}:${word.id}`;
      const previous = doc.captionCues.find((c) => c.id === id);
      const mappedStart =
        item.startFrame +
        Math.round(
          ((Math.max(word.startUs, item.sourceInUs) - item.sourceInUs) * fps) /
            1000000,
        );
      const mappedEnd = Math.min(
        item.startFrame + item.durationFrames,
        item.startFrame +
          Math.round(
            ((Math.min(word.endUs, item.sourceOutUs!) - item.sourceInUs) *
              fps) /
              1000000,
          ),
      );
      const startFrame = Math.max(
        item.startFrame,
        Math.min(
          item.startFrame + item.durationFrames - 1,
          mappedStart + (previous?.offsetFrames ?? 0),
        ),
      );
      cues.push({
        ...previous,
        id,
        text: previous?.edited ? previous.text : word.text,
        startFrame,
        durationFrames: Math.max(
          1,
          Math.min(
            item.startFrame + item.durationFrames - startFrame,
            previous?.manualDurationFrames ?? mappedEnd - mappedStart,
          ),
        ),
        source: {
          itemId: item.id,
          assetId: item.assetId,
          wordId: word.id,
          startUs: word.startUs,
          endUs: word.endUs,
        },
      });
    }
  }
  return cues.sort(
    (a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id),
  );
}

/** Carry manual edits to the new source occurrence created by split/duplicate. */
export function copyCaptionEdits(
  doc: ProjectDocument,
  fromId: string,
  toId: string,
) {
  for (const cue of [...doc.captionCues]) {
    if (cue.source?.itemId !== fromId) continue;
    doc.captionCues.push({
      ...structuredClone(cue),
      id: `caption:${toId}:${cue.source.wordId}`,
      source: { ...cue.source, itemId: toId },
    });
  }
}
