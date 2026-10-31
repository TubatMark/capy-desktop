import { NextResponse } from "next/server";
import { allocateSlot, audienceTz } from "@/lib/post-time";
import { publicAccounts } from "@/server/accounts";
import { queue, summary, taken, publicQueueEntry } from "@/server/queue";
import { effective } from "@/server/settings";

export const dynamic = "force-dynamic";

/** GET = every queue entry (or one clip's, with ?jobId=&n=), the summary, and the next free slot for the connected platforms. */
export async function GET(req?: Request) {
  const entries = queue().list();
  const params = new URL(req?.url ?? "http://x").searchParams;
  const jobId = params.get("jobId");
  const n = params.get("n");
  const shown = jobId === null ? entries : entries.filter((e) => e.jobId === jobId && (n === null || e.n === Number(n)));
  const now = new Date();
  const platforms = publicAccounts()
    .filter((a) => a.connected)
    .map((a) => a.platform);
  const tz = audienceTz(effective().postingAudience);
  // the same busy-times an approval uses, so the preview matches the slot it gets
  const nextFree = platforms.length
    ? allocateSlot(taken(entries, now), platforms, tz, now)?.getTime()
    : undefined;
  return NextResponse.json({
    entries: shown.map(publicQueueEntry),
    capabilities: publicAccounts()
      .map((a) => a.capabilities)
      .filter(Boolean),
    summary: summary(entries, now),
    nextFree,
    audienceTz: tz,
  });
}
