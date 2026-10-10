import { applyEdit, type EditResult } from "./operations";
import type { ProjectDocument, TimelineItem, TransformKeyframe } from "./types";
/** Local, declarative and versioned. No HTML, scripts, external assets or filesystem paths. */
export interface EditTemplate {
  id: "local-title";
  version: 1;
  instanceId: string;
  parameters: {
    text: string;
    placement: "intro" | "outro" | "callout" | "caption";
    durationFrames: number;
    color: string;
    startFrame?: number;
  };
}
export function applyTemplate(
  doc: ProjectDocument,
  template: EditTemplate,
): EditResult {
  const t = template,
    p = t.parameters;
  if (
    !t ||
    Object.keys(t).some(
      (k) => !["id", "version", "instanceId", "parameters"].includes(k),
    ) ||
    t.id !== "local-title" ||
    t.version !== 1 ||
    !/^[\w-]{1,100}$/.test(t.instanceId) ||
    !p ||
    Object.keys(p).some(
      (k) =>
        ![
          "text",
          "placement",
          "durationFrames",
          "color",
          "startFrame",
        ].includes(k),
    ) ||
    !["intro", "outro", "callout", "caption"].includes(p.placement) ||
    typeof p.text !== "string" ||
    !p.text.trim() ||
    p.text.length > 500 ||
    !/^#[\da-f]{6}$/i.test(p.color) ||
    !Number.isSafeInteger(p.durationFrames) ||
    p.durationFrames < 2 ||
    p.durationFrames > 1800
  )
    throw Error("Unsupported local template parameters");
  const end = Math.max(
    0,
    ...doc.items.map((i) => i.startFrame + i.durationFrames),
  );
  const startFrame =
    p.placement === "intro"
      ? 0
      : p.placement === "outro"
        ? end
        : (p.startFrame ?? 0);
  const y = p.placement === "caption" ? doc.canvas.height * 0.3 : 0;
  return applyEdit(doc, {
    type: "add-layer",
    kind: "text",
    item: {
      id: t.instanceId,
      trackId: "local-titles",
      startFrame,
      durationFrames: p.durationFrames,
      speed: 1,
      text: {
        value: p.text,
        fontSize: Math.round(doc.canvas.width * 0.08),
        color: p.color,
      },
      template: {
        id: t.id,
        version: 1,
        instanceId: t.instanceId,
        font: "Arial",
      },
      keyframes: [
        { frame: 0, x: -doc.canvas.width * 0.15, y, scale: 1, rotation: 0 },
        {
          frame: Math.min(p.durationFrames - 1, 15),
          x: 0,
          y,
          scale: 1,
          rotation: 0,
        },
      ],
    },
  });
}
/** Stateless linear interpolation in item-local integer project frames. */
export function motionAtFrame(
  item: TimelineItem,
  frame: number,
): Omit<TransformKeyframe, "frame"> {
  const keys = item.keyframes;
  const base = item.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 };
  if (!keys?.length) return base;
  const local = frame - item.startFrame;
  const right = keys.find((k) => k.frame > local),
    left = [...keys].reverse().find((k) => k.frame <= local) ?? keys[0]!;
  if (!right || right === left)
    return { x: left.x, y: left.y, scale: left.scale, rotation: left.rotation };
  const ratio = Math.max(
    0,
    Math.min(1, (local - left.frame) / (right.frame - left.frame)),
  );
  return {
    x: left.x + (right.x - left.x) * ratio,
    y: left.y + (right.y - left.y) * ratio,
    scale: left.scale + (right.scale - left.scale) * ratio,
    rotation: left.rotation + (right.rotation - left.rotation) * ratio,
  };
}
/** Generated arithmetic only; all saved properties are validated before reaching ffmpeg. */
export function motionExpression(
  item: TimelineItem,
  property: "x" | "y" | "scale" | "rotation",
  clock: string,
  fps: number,
): string {
  const keys = item.keyframes;
  if (!keys?.length)
    return String(item.transform?.[property] ?? (property === "scale" ? 1 : 0));
  let expression = String(keys.at(-1)![property]);
  for (let n = keys.length - 2; n >= 0; n--) {
    const a = keys[n]!,
      b = keys[n + 1]!;
    const start = a.frame / fps,
      end = b.frame / fps;
    expression = `if(lt(${clock},${end}),${a[property]}+(${b[property] - a[property]})*max(0,(${clock}-${start})/${end - start}),${expression})`;
  }
  return expression;
}
