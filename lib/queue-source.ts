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
export function queueLink(e: QueueEntry) {
  return (
    e.link ??
    (e.source?.kind === "studio"
      ? `/studio/${e.source.projectId}`
      : `/v/${e.jobId}/clip/${e.n}`)
  );
}
