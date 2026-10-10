import type { CaptionCue, ProjectDocument, TimelineItem } from "./types";
import {
  advanceSourceStart,
  sourceFrameTimeUs,
  sourcePhaseUs,
  type AudioChanges,
} from "./audio";
import {
  ceilUs,
  compareUs,
  integerUs,
  minimumUs,
  numberUs,
  validExactUs,
} from "./time";
import { copyCaptionEdits, mapCaptionCues } from "./caption-map";
export type EditOperation =
  | import("./retiming").EditProposal
  | { type: "retime"; itemId: string; speed: number }
  | {
      type: "freeze";
      itemId: string;
      frame: number;
      durationFrames: number;
      audioPolicy: "silence";
    }
  | {
      type: "keyframes";
      itemId: string;
      keyframes: NonNullable<TimelineItem["keyframes"]>;
    }
  | { type: "beat-marker"; frame: number; label: string }
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
  | { type: "audio"; itemId: string; changes: AudioChanges }
  | { type: "audio-duration"; itemId: string; durationFrames: number }
  | { type: "detach-audio"; itemId: string; newId: string; trackId: string }
  | { type: "relink-audio"; itemId: string }
  | {
      type: "caption";
      cueId: string;
      changes: Partial<
        Omit<
          CaptionCue,
          "id" | "source" | "offsetFrames" | "manualDurationFrames"
        >
      >;
    }
  | { type: "add-caption"; cue: CaptionCue }
  | { type: "remove-caption"; cueId: string }
  | { type: "add-layer"; item: TimelineItem; kind: "video" | "text" }
  | {
      type: "layer";
      itemId: string;
      changes: Pick<
        TimelineItem,
        "text" | "fit" | "opacity" | "crop" | "blur" | "colorPreset"
      >;
    }
  | { type: "safe-area"; enabled: boolean; inset: number }
  | {
      type: "transition";
      itemId: string;
      kind: "cut" | "crossfade";
      durationFrames: number;
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
  if (doc.sourceWords) doc.captionCues = mapCaptionCues(doc, doc.sourceWords);
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
    if (
      t.role !== undefined &&
      !["main", "overlay", "dialogue", "music", "sfx", "voiceover"].includes(
        t.role,
      )
    )
      throw Error("Invalid track role");
    for (const flag of [t.muted, t.solo])
      if (flag !== undefined && typeof flag !== "boolean")
        throw Error("Invalid track audio state");
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
      ![0.5, 1, 2].includes(i.speed) ||
      (!i.assetId && !i.text)
    )
      throw Error("Invalid timeline span");
    ids.add(i.id);
    if (i.speed !== 1 && i.loop)
      throw Error("Remove audio looping before changing playback speed");
    if (
      i.freeze &&
      (!i.assetId ||
        Object.keys(i.freeze).some(
          (k) => !["sourceUs", "audioPolicy"].includes(k),
        ) ||
        !integer(i.freeze.sourceUs) ||
        i.freeze.sourceUs < i.sourceInUs! ||
        i.freeze.sourceUs >= i.sourceOutUs! ||
        i.freeze.audioPolicy !== "silence" ||
        i.loop)
    )
      throw Error("Invalid freeze policy");
    if (
      i.template &&
      (Object.keys(i.template).some(
        (k) => !["id", "version", "instanceId", "font"].includes(k),
      ) ||
        i.template.id !== "local-title" ||
        i.template.version !== 1 ||
        i.template.font !== "Arial" ||
        i.template.instanceId !== i.id ||
        !i.text)
    )
      throw Error("Unsupported template identity");
    if (i.keyframes !== undefined) {
      if (d.tracks.find((t) => t.id === i.trackId)?.kind === "audio")
        throw Error("Motion requires a visual item");
      if (
        !Array.isArray(i.keyframes) ||
        i.keyframes.length > 100 ||
        i.keyframes.length < 1
      )
        throw Error("Invalid keyframes");
      let last = -1;
      for (const k of i.keyframes) {
        if (
          !k ||
          Object.keys(k).length !== 5 ||
          Object.keys(k).some(
            (f) => !["frame", "x", "y", "scale", "rotation"].includes(f),
          ) ||
          !integer(k.frame) ||
          k.frame >= i.durationFrames ||
          k.frame <= last ||
          ![k.x, k.y, k.scale, k.rotation].every(Number.isFinite) ||
          Math.abs(k.x) > 8192 ||
          Math.abs(k.y) > 8192 ||
          k.scale < 0.1 ||
          k.scale > 4 ||
          Math.abs(k.rotation) > 360
        )
          throw Error("Unsupported transform keyframe");
        last = k.frame;
      }
    }
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
    if (
      i.text &&
      (typeof i.text.value !== "string" ||
        i.text.value.length > 10000 ||
        !Number.isFinite(i.text.fontSize) ||
        i.text.fontSize <= 0 ||
        !/^#[0-9a-f]{6}$/i.test(i.text.color))
    )
      throw Error("Invalid text layer");
    for (const flag of [i.muted, i.solo, i.loop])
      if (flag !== undefined && typeof flag !== "boolean")
        throw Error("Invalid audio state");
    for (const fade of [i.fadeInFrames, i.fadeOutFrames])
      if (fade !== undefined && (!integer(fade) || fade > i.durationFrames))
        throw Error("Invalid fade duration");
    if (
      i.audioRole !== undefined &&
      !["dialogue", "music", "sfx", "voiceover"].includes(i.audioRole)
    )
      throw Error("Invalid audio role");
    if (
      i.ducking &&
      (typeof i.ducking.enabled !== "boolean" ||
        !Number.isFinite(i.ducking.reductionDb) ||
        i.ducking.reductionDb < 0 ||
        i.ducking.reductionDb > 60 ||
        !Number.isFinite(i.ducking.attackMs) ||
        i.ducking.attackMs < 0 ||
        i.ducking.attackMs > 10000 ||
        !Number.isFinite(i.ducking.releaseMs) ||
        i.ducking.releaseMs < 0 ||
        i.ducking.releaseMs > 10000)
    )
      throw Error("Invalid ducking settings");
    if (
      i.loopOffsetUs !== undefined &&
      (!integer(i.loopOffsetUs) ||
        i.loopOffsetUs >= i.sourceOutUs! - i.sourceInUs!)
    )
      throw Error("Invalid loop offset");
    if (
      i.sourceAvailableOutUs !== undefined &&
      (!i.assetId ||
        !integer(i.sourceAvailableOutUs, 1) ||
        i.sourceAvailableOutUs < i.sourceOutUs!)
    )
      throw Error("Invalid retained source extent");
    if (i.sourcePhaseUs !== undefined) {
      if (!i.assetId || !validExactUs(i.sourcePhaseUs))
        throw Error("Invalid source phase");
      // Non-loop starts store only the remainder below one microsecond.
      // Loop starts store a phase inside their source window, including legacy offsets.
      const limit = integerUs(i.loop ? i.sourceOutUs! - i.sourceInUs! : 1);
      if (compareUs(sourcePhaseUs(i), limit) >= 0)
        throw Error("Invalid source phase");
    }
    if (
      i.opacity !== undefined &&
      (!Number.isFinite(i.opacity) || i.opacity < 0 || i.opacity > 1)
    )
      throw Error("Invalid opacity");
    if (
      i.blur !== undefined &&
      (!Number.isFinite(i.blur) || i.blur < 0 || i.blur > 30)
    )
      throw Error("Invalid blur");
    if (
      i.colorPreset !== undefined &&
      !["neutral", "warm", "cool", "monochrome"].includes(i.colorPreset)
    )
      throw Error("Invalid color preset");
    if (
      i.crop &&
      (![i.crop.x, i.crop.y, i.crop.width, i.crop.height].every(
        Number.isFinite,
      ) ||
        i.crop.x < 0 ||
        i.crop.y < 0 ||
        i.crop.width <= 0 ||
        i.crop.height <= 0 ||
        i.crop.x + i.crop.width > 1 ||
        i.crop.y + i.crop.height > 1)
    )
      throw Error("Invalid crop");
    if (i.fit !== undefined && !["contain", "cover"].includes(i.fit))
      throw Error("Invalid layer fit");
    if (
      i.transitionOut &&
      (i.transitionOut.kind !== "crossfade" ||
        !integer(i.transitionOut.durationFrames, 1) ||
        i.transitionOut.durationFrames >= i.durationFrames)
    )
      throw Error("Invalid transition duration");
    if (
      i.gain !== undefined &&
      (!Number.isFinite(i.gain) || i.gain < 0 || i.gain > 4)
    )
      throw Error("Invalid gain");
  }
  for (const i of d.items) {
    const audio = i.detachedAudioId
      ? d.items.find((a) => a.id === i.detachedAudioId)
      : undefined;
    if (
      i.detachedAudioId &&
      (!audio ||
        audio.linkedVideoId !== i.id ||
        audio.assetId !== i.assetId ||
        audio.startFrame !== i.startFrame ||
        audio.durationFrames !== i.durationFrames ||
        audio.speed !== i.speed ||
        JSON.stringify(audio.freeze) !== JSON.stringify(i.freeze) ||
        audio.sourceInUs !== i.sourceInUs ||
        audio.sourceOutUs !== i.sourceOutUs ||
        compareUs(sourcePhaseUs(audio), sourcePhaseUs(i)) !== 0 ||
        (audio.sourceAvailableOutUs ?? audio.sourceOutUs) !==
          (i.sourceAvailableOutUs ?? i.sourceOutUs))
    )
      throw Error("Invalid detached audio link");
    if (
      i.linkedVideoId &&
      d.items.find((v) => v.id === i.linkedVideoId)?.detachedAudioId !== i.id
    )
      throw Error("Invalid source audio link");
  }
  if (
    d.safeArea &&
    (typeof d.safeArea.enabled !== "boolean" ||
      !Number.isFinite(d.safeArea.inset) ||
      d.safeArea.inset < 0 ||
      d.safeArea.inset > 0.4)
  )
    throw Error("Invalid safe area");
  if (d.sourceWords)
    for (const source of d.sourceWords) {
      if (typeof source.assetId !== "string" || !Array.isArray(source.words))
        throw Error("Invalid source words");
      const wordIds = new Set<string>();
      for (const word of source.words) {
        if (
          !word.id ||
          wordIds.has(word.id) ||
          !integer(word.startUs) ||
          !integer(word.endUs, 1) ||
          word.endUs <= word.startUs ||
          typeof word.text !== "string"
        )
          throw Error("Invalid source word");
        wordIds.add(word.id);
      }
    }
  if (
    d.beatMarkers !== undefined &&
    (!Array.isArray(d.beatMarkers) ||
      d.beatMarkers.length > 10000 ||
      d.beatMarkers.some(
        (m) =>
          !m ||
          Object.keys(m).some((k) => !["frame", "label"].includes(k)) ||
          !integer(m.frame) ||
          typeof m.label !== "string" ||
          m.label.length > 100,
      ))
  )
    throw Error("Invalid beat marker");
  const cueIds = new Set<string>();
  for (const c of d.captionCues)
    if (
      !c ||
      typeof c.id !== "string" ||
      cueIds.has(c.id) ||
      typeof c.text !== "string" ||
      !integer(c.startFrame) ||
      !integer(c.durationFrames, 1)
    )
      throw Error("Invalid caption cue");
    else {
      cueIds.add(c.id);
      for (const position of [c.x, c.y])
        if (
          position !== undefined &&
          (!Number.isFinite(position) || position < 0 || position > 1)
        )
          throw Error("Invalid caption position");
      if (
        c.fontSize !== undefined &&
        (!Number.isFinite(c.fontSize) || c.fontSize <= 0 || c.fontSize > 1000)
      )
        throw Error("Invalid caption font");
      if (c.color !== undefined && !/^#[0-9a-f]{6}$/i.test(c.color))
        throw Error("Invalid caption color");
      if (c.offsetFrames !== undefined && !Number.isSafeInteger(c.offsetFrames))
        throw Error("Invalid caption offset");
      if (
        c.manualDurationFrames !== undefined &&
        !integer(c.manualDurationFrames, 1)
      )
        throw Error("Invalid caption duration");
      if (
        c.source &&
        (!d.items.some(
          (i) => i.id === c.source!.itemId && i.assetId === c.source!.assetId,
        ) ||
          !integer(c.source.startUs) ||
          !integer(c.source.endUs, 1) ||
          c.source.endUs <= c.source.startUs)
      )
        throw Error("Invalid caption source");
    }
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
  if (op.type === "suggested") {
    if (
      op.baseRevision !== doc.revision ||
      op.baseDocument !== JSON.stringify(doc)
    )
      throw Error("Suggestion base revision or edits changed");
    if (
      !op.selectedItemIds.length ||
      op.selectedItemIds.length > 50 ||
      new Set(op.selectedItemIds).size !== op.selectedItemIds.length ||
      op.selectedItemIds.some((id) => !doc.items.some((i) => i.id === id)) ||
      !Array.isArray(op.operations) ||
      op.operations.length > 200
    )
      throw Error("Invalid suggestion selection");
    let result = doc;
    for (const change of op.operations) {
      if (
        !["trim", "layer"].includes(change.type) ||
        !("itemId" in change) ||
        !op.selectedItemIds.includes(change.itemId)
      )
        throw Error("Suggestion exceeds selected items");
      const selected = doc.items.find((i) => i.id === change.itemId)!;
      if (selected.linkedVideoId || selected.detachedAudioId)
        throw Error("Select attached source audio for assistance");
      result = applyEdit(result, change).document;
    }
    if (
      result.items.some(
        (i) =>
          !op.selectedItemIds.includes(i.id) &&
          JSON.stringify(i) !==
            JSON.stringify(doc.items.find((o) => o.id === i.id)),
      )
    )
      throw Error("Suggestion changed an unselected item");
    return {
      document: result,
      inverse: { type: "restore", document: structuredClone(doc) },
    };
  }
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
  let item =
    "itemId" in op ? next.items.find((i) => i.id === op.itemId) : undefined;
  if ("itemId" in op && !item) throw Error("Item not found");
  if (
    item?.linkedVideoId &&
    [
      "move",
      "trim",
      "split",
      "remove",
      "ripple-delete",
      "duplicate",
      "retime",
      "freeze",
    ].includes(op.type)
  )
    item = next.items.find((i) => i.id === item!.linkedVideoId)!;
  if (item?.freeze && ["split", "trim"].includes(op.type))
    throw Error("Unfreeze using Undo before splitting or trimming this hold");
  if (item?.keyframes && ["split", "trim"].includes(op.type))
    throw Error("Remove motion keyframes before splitting or trimming");
  switch (op.type) {
    case "retime": {
      if (
        ![0.5, 1, 2].includes(op.speed) ||
        !item!.assetId ||
        item!.freeze ||
        item!.keyframes ||
        item!.loop
      )
        throw Error("Unsupported retime; remove freeze, loop or motion first");
      const ratio = item!.speed / op.speed;
      item!.durationFrames = Math.max(
        1,
        Math.round(
          ((item!.sourceOutUs! -
            numberUs(sourceFrameTimeUs(item!, item!.startFrame, next))) *
            next.fps.numerator) /
            (1e6 * next.fps.denominator * op.speed),
        ),
      );
      for (const key of ["fadeInFrames", "fadeOutFrames"] as const)
        if (item![key] !== undefined)
          item![key] = Math.min(
            item!.durationFrames,
            Math.round(item![key]! * ratio),
          );
      item!.speed = op.speed as TimelineItem["speed"];
      break;
    }
    case "freeze": {
      if (
        !item!.assetId ||
        item!.loop ||
        !integer(op.frame) ||
        op.frame >= item!.durationFrames ||
        op.audioPolicy !== "silence" ||
        !integer(op.durationFrames, 1)
      )
        throw Error("Invalid freeze request");
      item!.freeze = {
        sourceUs: Math.round(
          numberUs(sourceFrameTimeUs(item!, item!.startFrame + op.frame, next)),
        ),
        audioPolicy: op.audioPolicy,
      };
      item!.durationFrames = op.durationFrames;
      delete item!.keyframes;
      delete item!.fadeInFrames;
      delete item!.fadeOutFrames;
      break;
    }
    case "keyframes":
      item!.keyframes = structuredClone(op.keyframes);
      if (!op.keyframes.length) delete item!.keyframes;
      break;
    case "beat-marker":
      (next.beatMarkers ??= []).push({ frame: op.frame, label: op.label });
      break;
    case "split": {
      if (
        !integer(op.frame, 1) ||
        op.frame >= item!.durationFrames ||
        next.items.some((i) => i.id === op.newId)
      )
        throw Error("Split must be inside item");
      const right = {
        ...structuredClone(item!),
        id: op.newId,
        startFrame: item!.startFrame + op.frame,
        durationFrames: item!.durationFrames - op.frame,
      };
      if (right.template) right.template.instanceId = right.id;
      if (item!.assetId) {
        const available = item!.sourceAvailableOutUs ?? item!.sourceOutUs!;
        const boundary = minimumUs(
          sourceFrameTimeUs(item!, item!.startFrame + op.frame, next),
          integerUs(item!.sourceOutUs!),
        );
        advanceSourceStart(right, op.frame, next);
        if (!item!.loop) {
          item!.sourceOutUs = ceilUs(boundary);
          item!.sourceAvailableOutUs = available;
          right.sourceAvailableOutUs = available;
        }
      }
      item!.durationFrames = op.frame;
      delete item!.transitionOut;
      copyCaptionEdits(next, item!.id, right.id);
      if (item!.detachedAudioId) {
        const audio = next.items.find((i) => i.id === item!.detachedAudioId)!;
        const audioId = `${op.newId}:audio`;
        right.detachedAudioId = audioId;
        next.items.push({
          ...structuredClone(audio),
          id: audioId,
          linkedVideoId: right.id,
          startFrame: right.startFrame,
          durationFrames: right.durationFrames,
          sourceInUs: right.sourceInUs,
          sourceOutUs: right.sourceOutUs,
        });
      }
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
      if (item!.assetId) {
        const available = item!.sourceAvailableOutUs ?? item!.sourceOutUs!;
        const boundary = minimumUs(
          sourceFrameTimeUs(item!, item!.startFrame + op.outFrame, next),
          integerUs(item!.sourceOutUs!),
        );
        advanceSourceStart(item!, op.inFrame, next);
        if (!item!.loop) {
          item!.sourceOutUs = ceilUs(boundary);
          item!.sourceAvailableOutUs = available;
        }
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
        const followingId = op.itemIds
          .slice(op.itemIds.indexOf(id) + 1)
          .find(
            (nextId) =>
              next.items.find((candidate) => candidate.id === nextId)
                ?.trackId === i.trackId,
          );
        const following = next.items.find(
          (candidate) => candidate.id === followingId,
        );
        if (
          i.transitionOut &&
          (!following ||
            i.transitionOut.durationFrames >= following.durationFrames)
        )
          delete i.transitionOut;
        i.startFrame = cursor.get(i.trackId) ?? 0;
        cursor.set(
          i.trackId,
          i.startFrame +
            i.durationFrames -
            (i.transitionOut?.durationFrames ?? 0),
        );
        return i;
      });
      break;
    }
    case "duplicate":
      next.items.push({
        ...structuredClone(item!),
        id: op.newId,
        startFrame: item!.startFrame + item!.durationFrames,
        ...(item!.template
          ? { template: { ...item!.template, instanceId: op.newId } }
          : {}),
        detachedAudioId: undefined,
        transitionOut: undefined,
      });
      copyCaptionEdits(next, item!.id, op.newId);
      if (item!.detachedAudioId) {
        const audio = next.items.find((i) => i.id === item!.detachedAudioId)!;
        const duplicated = next.items.find((i) => i.id === op.newId)!;
        duplicated.detachedAudioId = `${op.newId}:audio`;
        next.items.push({
          ...structuredClone(audio),
          id: duplicated.detachedAudioId,
          linkedVideoId: op.newId,
          startFrame: duplicated.startFrame,
        });
      }
      break;
    case "remove":
    case "ripple-delete":
      next.items = next.items.filter(
        (i) => i.id !== item!.id && i.id !== item!.detachedAudioId,
      );
      next.captionCues = next.captionCues.filter(
        (c) => c.source?.itemId !== item!.id,
      );
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
    case "audio": {
      const previousPhase = sourcePhaseUs(item!);
      const wasLoop = item!.loop;
      Object.assign(item!, op.changes);
      if (op.changes.loop === false && item!.sourceInUs !== undefined) {
        if (wasLoop) {
          item!.sourcePhaseUs = previousPhase;
          delete item!.loopOffsetUs;
          advanceSourceStart(item!, 0, next);
        }
        item!.durationFrames = Math.min(
          item!.durationFrames,
          Math.max(
            1,
            Math.round(
              ((item!.sourceOutUs! - item!.sourceInUs) * next.fps.numerator) /
                (1000000 * next.fps.denominator),
            ),
          ),
        );
        delete item!.loopOffsetUs;
        item!.fadeInFrames = Math.min(
          item!.fadeInFrames ?? 0,
          item!.durationFrames,
        );
        item!.fadeOutFrames = Math.min(
          item!.fadeOutFrames ?? 0,
          item!.durationFrames,
        );
      }
      break;
    }
    case "audio-duration": {
      const available = item!.sourceAvailableOutUs ?? item!.sourceOutUs!;
      const sourceFrames = Math.max(
        1,
        Math.round(
          ((available -
            numberUs(sourceFrameTimeUs(item!, item!.startFrame, next))) *
            next.fps.numerator) /
            (1000000 * next.fps.denominator),
        ),
      );
      if (
        next.tracks.find((t) => t.id === item!.trackId)?.kind !== "audio" ||
        item!.linkedVideoId ||
        !integer(op.durationFrames, 1) ||
        (!item!.loop && op.durationFrames > sourceFrames)
      )
        throw Error("Enable looping to extend an imported sound");
      item!.durationFrames = op.durationFrames;
      if (!item!.loop) {
        item!.sourceAvailableOutUs = available;
        item!.sourceOutUs = ceilUs(
          minimumUs(
            sourceFrameTimeUs(
              item!,
              item!.startFrame + op.durationFrames,
              next,
            ),
            integerUs(available),
          ),
        );
      }
      item!.fadeInFrames = Math.min(
        item!.fadeInFrames ?? 0,
        item!.durationFrames,
      );
      item!.fadeOutFrames = Math.min(
        item!.fadeOutFrames ?? 0,
        item!.durationFrames,
      );
      break;
    }
    case "detach-audio": {
      if (
        !item!.assetId ||
        item!.detachedAudioId ||
        item!.linkedVideoId ||
        next.tracks.find((t) => t.id === item!.trackId)?.kind !== "video" ||
        next.items.some((i) => i.id === op.newId)
      )
        throw Error("Cannot detach this source audio");
      if (!next.tracks.some((t) => t.id === op.trackId))
        next.tracks.push({ id: op.trackId, kind: "audio", role: "dialogue" });
      if (next.tracks.find((t) => t.id === op.trackId)?.kind !== "audio")
        throw Error("Audio track required");
      const detached = {
        ...structuredClone(item!),
        id: op.newId,
        trackId: op.trackId,
        linkedVideoId: item!.id,
        audioRole: "dialogue" as const,
      };
      delete detached.transitionOut;
      delete detached.transform;
      delete detached.keyframes;
      next.items.push(detached);
      item!.detachedAudioId = op.newId;
      break;
    }
    case "relink-audio": {
      const video = item!.linkedVideoId
        ? next.items.find((i) => i.id === item!.linkedVideoId)!
        : item!;
      const audio = next.items.find((i) => i.id === video.detachedAudioId);
      if (!audio) throw Error("No detached audio to relink");
      for (const key of [
        "gain",
        "muted",
        "solo",
        "fadeInFrames",
        "fadeOutFrames",
        "audioRole",
        "ducking",
      ] as const)
        Object.assign(video, { [key]: audio[key] });
      next.items = next.items.filter((i) => i.id !== audio.id);
      delete video.detachedAudioId;
      break;
    }
    case "caption": {
      const cue = next.captionCues.find((c) => c.id === op.cueId);
      if (!cue) throw Error("Caption not found");
      if (op.changes.startFrame !== undefined && cue.source)
        cue.offsetFrames =
          (cue.offsetFrames ?? 0) + op.changes.startFrame - cue.startFrame;
      if (op.changes.durationFrames !== undefined && cue.source)
        cue.manualDurationFrames = op.changes.durationFrames;
      Object.assign(cue, op.changes, { edited: true });
      break;
    }
    case "add-caption":
      next.captionCues.push(structuredClone(op.cue));
      break;
    case "remove-caption":
      next.captionCues = next.captionCues.filter((c) => c.id !== op.cueId);
      break;
    case "add-layer":
      if (!next.tracks.some((t) => t.id === op.item.trackId))
        next.tracks.push({
          id: op.item.trackId,
          kind: op.kind,
          role: "overlay",
        });
      if (next.tracks.find((t) => t.id === op.item.trackId)?.role !== "overlay")
        throw Error("Overlay track required");
      next.items.push(structuredClone(op.item));
      break;
    case "layer":
      Object.assign(item!, op.changes);
      break;
    case "safe-area":
      next.safeArea = { enabled: op.enabled, inset: op.inset };
      break;
    case "transition": {
      const ordered = next.items
        .filter((i) => i.trackId === item!.trackId)
        .sort((a, b) => a.startFrame - b.startFrame);
      const index = ordered.indexOf(item!),
        following = ordered[index + 1];
      const old = item!.transitionOut?.durationFrames ?? 0,
        newDuration = op.kind === "cut" ? 0 : op.durationFrames;
      if (
        op.kind === "cut" &&
        (!following ||
          following.startFrame !==
            item!.startFrame + item!.durationFrames - old)
      ) {
        delete item!.transitionOut;
        break;
      }
      if (
        !following ||
        !integer(newDuration) ||
        (newDuration &&
          (newDuration >= item!.durationFrames ||
            newDuration >= following.durationFrames)) ||
        following.startFrame !== item!.startFrame + item!.durationFrames - old
      )
        throw Error(
          "Transition requires adjacent footage and an interior duration",
        );
      for (const later of ordered.slice(index + 1))
        later.startFrame += old - newDuration;
      if (newDuration)
        item!.transitionOut = {
          kind: "crossfade",
          durationFrames: newDuration,
        };
      else delete item!.transitionOut;
      break;
    }
    case "transform":
      item!.transform = op.transform;
      break;
    default:
      throw Error("Unknown edit operation");
  }
  for (const video of next.items.filter((i) => i.detachedAudioId)) {
    const linked = next.items.find((i) => i.id === video.detachedAudioId)!;
    Object.assign(linked, {
      startFrame: video.startFrame,
      durationFrames: video.durationFrames,
      sourceInUs: video.sourceInUs,
      sourceOutUs: video.sourceOutUs,
      sourcePhaseUs: video.sourcePhaseUs,
      sourceAvailableOutUs: video.sourceAvailableOutUs,
      speed: video.speed,
      freeze: video.freeze,
    });
  }
  if (["trim", "split", "retime", "freeze"].includes(op.type))
    for (const changed of next.items) {
      if (changed.fadeInFrames !== undefined)
        changed.fadeInFrames = Math.min(
          changed.fadeInFrames,
          changed.durationFrames,
        );
      if (changed.fadeOutFrames !== undefined)
        changed.fadeOutFrames = Math.min(
          changed.fadeOutFrames,
          changed.durationFrames,
        );
    }
  for (const outgoing of next.items.filter((i) => i.transitionOut)) {
    const duration = outgoing.transitionOut!.durationFrames;
    if (
      duration >= outgoing.durationFrames ||
      !next.items.some(
        (incoming) =>
          incoming.id !== outgoing.id &&
          incoming.trackId === outgoing.trackId &&
          incoming.startFrame ===
            outgoing.startFrame + outgoing.durationFrames - duration &&
          incoming.durationFrames > duration,
      )
    )
      delete outgoing.transitionOut;
  }
  mapSources(next);
  validateProject(next);
  return { document: next, inverse };
}
