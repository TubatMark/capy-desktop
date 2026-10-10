import { z } from "zod";
import { queue, deliveryMutationReason, publicQueueEntry } from "./queue";
import { decide, eligibility, hashManifest } from "./publication-policy";
import { runtimeStore } from "./db/runtime";
import { fence } from "./worker/context";
export const RemoteScheduleInput = z.strictObject({
  publishAt: z.number().int().positive(),
  uploadAheadMinutes: z.number().int().min(1).max(1440),
  acknowledgeRemoteSchedule: z.literal(true),
});
/** Explicit human action; existing public approvals are never converted by a worker tick. */
export function approveRemoteSchedule(
  key: string,
  input: z.infer<typeof RemoteScheduleInput>,
) {
  const options = RemoteScheduleInput.parse(input);
  if (
    options.publishAt < Date.now() + 120000 ||
    options.publishAt > Date.now() + 30 * 86400000
  )
    throw Error("Choose a time between two minutes and thirty days from now");
  return fence(() =>
    runtimeStore().transaction(() => {
      const current = queue()
        .list()
        .find((e) => e.key === key);
      if (!current || current.platform !== "youtube")
        throw Error("Select a YouTube queue entry");
      const blocked = deliveryMutationReason(current);
      if (blocked) throw Error(blocked);
      const prior = eligibility(current);
      if (!prior.allowed) throw Error(prior.reasons.join("; "));
      const candidate = decide(
        {
          ...current,
          slotAt: options.publishAt,
          remoteSchedule: {
            publishAt: options.publishAt,
            uploadAheadMinutes: options.uploadAheadMinutes,
            schedulePolicy: "youtube-schedule-v1",
          },
        },
        false,
        new Date(),
      );
      const old = current.publishPackage!,
        pkg = candidate.publishPackage!;
      if (
        hashManifest(old.thumbnail) !== hashManifest(pkg.thumbnail) ||
        hashManifest(old.artifact) !== hashManifest(pkg.artifact)
      )
        throw Error("Publication media changed during scheduling");
      const attachment = runtimeStore().get<Record<string, unknown>>(
        "thumbnail-attachments",
        old.packageHash,
      )?.value;
      if (attachment)
        runtimeStore().put("thumbnail-attachments", pkg.packageHash, {
          ...attachment,
          packageId: pkg.id,
        });
      const allowed = eligibility(candidate);
      if (!allowed.allowed) throw Error(allowed.reasons.join("; "));
      runtimeStore().put("publication-history", old.packageHash, old);
      const scheduled = {
        ...candidate,
        status: "scheduled" as const,
        attempts: 0,
        nextTryAt: undefined,
        error: undefined,
        history: [
          ...candidate.history,
          {
            t: Date.now(),
            msg: "Explicitly approved YouTube upload-ahead and remote schedule; local pause cannot cancel it",
          },
        ],
      };
      queue().mutate((all) => all.map((e) => (e.key === key ? scheduled : e)));
      return publicQueueEntry(scheduled);
    }),
  );
}
