import { runtimeStore } from "./db/runtime";

/**
 * When the original video went up: what decides how much anyone still cares about a clip of it. Discovery dates it from
 * YouTube; live streams go by when they ended. Clips with no known date count from when capy made them.
 */
export function sourceUploadedAt(jobId?: string): number | undefined {
  if (!jobId) return undefined;
  const store = runtimeStore();
  const link = store.get<{ channelId: string }>("automation-jobs", jobId)?.value;
  if (!link) return undefined;
  const video = store.get<{ video?: { publishedAt?: number; endedAt?: number } }>("discovery-videos", `${link.channelId}:${jobId}`)?.value.video;
  const at = video?.publishedAt ?? video?.endedAt;
  return Number.isFinite(at) ? at : undefined;
}

export const entrySourceAt = (e: { jobId?: string; createdAt: number }) => sourceUploadedAt(e.jobId) ?? e.createdAt;
