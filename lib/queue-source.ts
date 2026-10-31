import { z } from "zod";
import type { QueueEntry } from "./types";
export const StudioQueueSourceSchema = z.strictObject({
  kind: z.literal("studio"),
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  renderId: z.string().min(1),
  renderChecksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export function queueGroup(e: QueueEntry) {
  return e.source?.kind === "studio"
    ? `studio:${e.source.projectId}:${e.source.revision}:${e.source.renderId}`
    : `${e.jobId}:${e.n}`;
}
export function queueCollection(e: QueueEntry) {
  return e.source?.kind === "studio"
    ? `studio:${e.source.projectId}`
    : (e.jobId ?? e.key);
}
/** Stories and Studio no longer have pages, and older queue entries may still have their links saved. */
const REMOVED_PAGE = /^\/(stories|studio)(\/|$)/;
export function queueLink(e: QueueEntry) {
  if (e.link && !REMOVED_PAGE.test(e.link)) return e.link;
  return e.link || e.source?.kind === "studio" ? "/short-form" : `/v/${e.jobId}/clip/${e.n}`;
}
