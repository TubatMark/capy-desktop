import { applyEdit, type EditResult } from "./operations";
import type { ProjectDocument } from "./types";
export function retimeItem(
  doc: ProjectDocument,
  itemId: string,
  speed: number,
): EditResult {
  return applyEdit(doc, { type: "retime", itemId, speed });
}
export function freezeItem(
  doc: ProjectDocument,
  itemId: string,
  frame: number,
  durationFrames: number,
  audioPolicy: "silence",
): EditResult {
  return applyEdit(doc, {
    type: "freeze",
    itemId,
    frame,
    durationFrames,
    audioPolicy,
  });
}

export interface EditProposal {
  type: "suggested";
  baseRevision: number;
  baseDocument: string;
  selectedItemIds: string[];
  operations: import("./operations").EditOperation[];
  explanation: string;
}
export function applyBoundSuggestions(
  doc: ProjectDocument,
  proposals: import("./operations").EditOperation[],
  selection: string[],
): EditResult {
  if (proposals.length !== 1 || proposals[0]?.type !== "suggested")
    throw Error("Invalid suggestion bundle");
  const p = proposals[0];
  if (
    JSON.stringify([...selection].sort()) !==
    JSON.stringify([...p.selectedItemIds].sort())
  )
    throw Error("Suggestion selection changed");
  return applyEdit(doc, p);
}
