import type { ProjectDocument, TimelineItem } from "./types";
export type EditOperation =
  | { type: "split"; itemId: string; frame: number; newId: string }
  | { type: "trim"; itemId: string; inFrame: number; outFrame: number }
  | { type: "move"; itemId: string; startFrame: number; trackId?: string }
  | { type: "reorder"; itemIds: string[] }
  | { type: "duplicate"; itemId: string; newId: string }
  | { type: "remove" | "ripple-delete"; itemId: string }
  | { type: "add-asset"; item: TimelineItem }
  | {
      type: "transform";
      itemId: string;
      transform: NonNullable<TimelineItem["transform"]>;
    }
  | { type: "restore"; document: ProjectDocument };
export interface EditResult {
  document: ProjectDocument;
  inverse: EditOperation;
}
const integer = (n: number, min = 0) => Number.isSafeInteger(n) && n >= min;
export function frameUs(frame: number, doc: Pick<ProjectDocument, "fps">) {
  return Math.round(
    (frame * 1000000 * doc.fps.denominator) / doc.fps.numerator,
  );
}
export function mapSources(doc: ProjectDocument) {
  doc.sourceMappings = doc.items
    .filter(
      (i) =>
        i.assetId && i.sourceInUs !== undefined && i.sourceOutUs !== undefined,
    )
    .map((i) => ({
      itemId: i.id,
      assetId: i.assetId!,
      sourceInUs: i.sourceInUs!,
      sourceOutUs: i.sourceOutUs!,
    }));
  return doc;
}
export function validateProject(
  value: unknown,
): asserts value is ProjectDocument {
  const d = value as ProjectDocument;
  if (
    !d ||
    d.schemaVersion !== 1 ||
    typeof d.id !== "string" ||
    !d.id ||
    !integer(d.revision) ||
    !d.canvas ||
    !integer(d.canvas.width, 1) ||
    !integer(d.canvas.height, 1) ||
    d.canvas.width > 8192 ||
    d.canvas.height > 8192 ||
    !d.fps ||
    !integer(d.fps.numerator, 1) ||
    !integer(d.fps.denominator, 1) ||
    d.fps.numerator / d.fps.denominator > 240 ||
    !Array.isArray(d.tracks) ||
    !Array.isArray(d.items) ||
    !Array.isArray(d.captionCues) ||
    !Array.isArray(d.sourceMappings) ||
    !Array.isArray(d.thumbnailIds) ||
    d.items.length > 10000
  )
    throw Error("Invalid project document");
  const tracks = new Set<string>();
  for (const t of d.tracks) {
    if (
      !t ||
      typeof t.id !== "string" ||
      !t.id ||
      tracks.has(t.id) ||
      !["video", "audio", "text"].includes(t.kind)
    )
      throw Error("Invalid track");
    tracks.add(t.id);
  }
  const ids = new Set<string>();
  for (const i of d.items) {
    if (
      !i ||
      typeof i.id !== "string" ||
      !i.id ||
      ids.has(i.id) ||
      !tracks.has(i.trackId) ||
      !integer(i.startFrame) ||
      !integer(i.durationFrames, 1) ||
      !integer(i.startFrame + i.durationFrames) ||
      i.speed !== 1 ||
      (!i.assetId && !i.text)
    )
      throw Error("Invalid timeline span");
    ids.add(i.id);
    if (
      i.assetId &&
      (typeof i.assetId !== "string" ||
        !integer(i.sourceInUs!) ||
        !integer(i.sourceOutUs!, 1) ||
        i.sourceOutUs! <= i.sourceInUs!)
    )
      throw Error("Invalid source range");
    if (
      i.transform &&
      (![
        i.transform.x,
        i.transform.y,
        i.transform.scale,
        i.transform.rotation,
      ].every(Number.isFinite) ||
        i.transform.scale <= 0)
    )
      throw Error("Invalid transform");
    if (i.gain !== undefined && (!Number.isFinite(i.gain) || i.gain < 0))
      throw Error("Invalid gain");
  }
  for (const c of d.captionCues)
    if (
      !c ||
      typeof c.id !== "string" ||
      typeof c.text !== "string" ||
      !integer(c.startFrame) ||
      !integer(c.durationFrames, 1)
    )
      throw Error("Invalid caption cue");
  if (
    d.name !== undefined &&
    (typeof d.name !== "string" || d.name.length > 200)
  )
    throw Error("Invalid project name");
  const expected = structuredClone(d);
  mapSources(expected);
  if (
    JSON.stringify(expected.sourceMappings) !== JSON.stringify(d.sourceMappings)
  )
    throw Error("Invalid source mapping");
}
export function applyEdit(doc: ProjectDocument, op: EditOperation): EditResult {
  validateProject(doc);
  const inverse: EditOperation = {
    type: "restore",
    document: structuredClone(doc),
  };
  const next = structuredClone(
    op.type === "restore"
      ? { ...op.document, id: doc.id, revision: doc.revision }
      : doc,
  );
  if (op.type === "restore") {
    validateProject(next);
    return { document: next, inverse };
  }
  const item =
    "itemId" in op ? next.items.find((i) => i.id === op.itemId) : undefined;
  if ("itemId" in op && !item) throw Error("Item not found");
  switch (op.type) {
    case "split": {
      if (
        !integer(op.frame, 1) ||
        op.frame >= item!.durationFrames ||
        next.items.some((i) => i.id === op.newId)
      )
        throw Error("Split must be inside item");
      const source =
        item!.sourceInUs === undefined
          ? undefined
          : item!.sourceInUs +
            Math.round(
              ((item!.sourceOutUs! - item!.sourceInUs) * op.frame) /
                item!.durationFrames,
            );
      const right = {
        ...structuredClone(item!),
        id: op.newId,
        startFrame: item!.startFrame + op.frame,
        durationFrames: item!.durationFrames - op.frame,
        sourceInUs: source,
      };
      item!.durationFrames = op.frame;
      if (source !== undefined) item!.sourceOutUs = source;
      next.items.splice(next.items.indexOf(item!) + 1, 0, right);
      break;
    }
    case "trim": {
      if (
        !integer(op.inFrame) ||
        !integer(op.outFrame, 1) ||
        op.inFrame >= op.outFrame ||
        op.outFrame > item!.durationFrames
      )
        throw Error("Trim outside source span");
      const from = item!.sourceInUs;
      const span = from === undefined ? 0 : item!.sourceOutUs! - from;
      const old = item!.durationFrames;
      if (from !== undefined) {
        item!.sourceInUs = from + Math.round((span * op.inFrame) / old);
        item!.sourceOutUs = from + Math.round((span * op.outFrame) / old);
      }
      item!.durationFrames = op.outFrame - op.inFrame;
      break;
    }
    case "move":
      item!.startFrame = op.startFrame;
      if (op.trackId) item!.trackId = op.trackId;
      break;
    case "reorder": {
      if (
        op.itemIds.length !== new Set(op.itemIds).size ||
        op.itemIds.length !== next.items.length ||
        op.itemIds.some((id) => !next.items.some((i) => i.id === id))
      )
        throw Error("Reorder must contain every item once");
      const cursor = new Map<string, number>();
      next.items = op.itemIds.map((id) => {
        const i = next.items.find((i) => i.id === id)!;
        i.startFrame = cursor.get(i.trackId) ?? 0;
        cursor.set(i.trackId, i.startFrame + i.durationFrames);
        return i;
      });
      break;
    }
    case "duplicate":
      next.items.push({
        ...structuredClone(item!),
        id: op.newId,
        startFrame: item!.startFrame + item!.durationFrames,
      });
      break;
    case "remove":
    case "ripple-delete":
      next.items = next.items.filter((i) => i.id !== item!.id);
      if (op.type === "ripple-delete")
        for (const i of next.items)
          if (
            i.trackId === item!.trackId &&
            i.startFrame >= item!.startFrame + item!.durationFrames
          )
            i.startFrame -= item!.durationFrames;
      break;
    case "add-asset":
      next.items.push(structuredClone(op.item));
      break;
    case "transform":
      item!.transform = op.transform;
      break;
    default:
      throw Error("Unknown edit operation");
  }
  mapSources(next);
  validateProject(next);
  return { document: next, inverse };
}
