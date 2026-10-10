import { NextResponse } from "next/server";
import { allocateSlot, audienceTz } from "@/lib/post-time";
import { publicAccounts } from "@/server/accounts";
import { queue, summary, taken, publicQueueEntry } from "@/server/queue";
import { effective } from "@/server/settings";

export const dynamic = "force-dynamic";

/** GET = every queue entry, the summary, and the next free slot for the connected platforms. */
export async function GET() {
  const entries = queue().list();
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
    entries: entries.map(publicQueueEntry),
    capabilities: publicAccounts()
      .map((a) => a.capabilities)
      .filter(Boolean),
    summary: summary(entries, now),
    nextFree,
    audienceTz: tz,
  });
}
