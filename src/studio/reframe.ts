import type { AssetRef, TimelineItem } from "../../lib/studio/types";
export interface SpeakerRegion {
  sourceChecksum: string;
  confirmedByUser: true;
  startUs: number;
  endUs: number;
  crop: NonNullable<TimelineItem["crop"]>;
}
/** User-confirmed source evidence, not automatic speaker recognition. */
export function reframeFromSpeaker(
  region: SpeakerRegion,
  checksum: string,
  startUs: number,
  endUs: number,
): NonNullable<TimelineItem["crop"]> {
  const c = region?.crop;
  if (
    !region ||
    region.confirmedByUser !== true ||
    region.sourceChecksum !== checksum ||
    region.startUs > startUs ||
    region.endUs < endUs ||
    !c ||
    Object.keys(c).some((k) => !["x", "y", "width", "height"].includes(k)) ||
    ![c.x, c.y, c.width, c.height, region.startUs, region.endUs].every(
      Number.isFinite,
    ) ||
    c.x < 0 ||
    c.y < 0 ||
    c.width <= 0 ||
    c.height <= 0 ||
    c.x + c.width > 1 ||
    c.y + c.height > 1
  )
    throw Error(
      "Speaker region must be user-confirmed and cover the selected source span",
    );
  return structuredClone(c);
}

/** Confirmation is scoped to the exact selected occurrence and source window. */
export function speakerSourceFingerprint(
  item: TimelineItem | undefined,
  asset: AssetRef | undefined,
): string {
  return JSON.stringify([
    item?.id,
    item?.assetId,
    asset?.checksum,
    item?.sourceInUs,
    item?.sourceOutUs,
    item?.sourcePhaseUs,
    item?.durationFrames,
    item?.speed,
    item?.freeze,
  ]);
}
