import type { ProjectDocument, TimelineItem } from "./types";
/** Same canvas-space transform for main footage, incoming crossfade footage and overlays. */
export function visualTransform(
  item: TimelineItem,
  canvas: ProjectDocument["canvas"],
): string | undefined {
  const transform = item.transform;
  return transform
    ? `translate(${(transform.x / canvas.width) * 100}%, ${(transform.y / canvas.height) * 100}%) scale(${transform.scale}) rotate(${transform.rotation}deg)`
    : undefined;
}
