import { NextResponse } from "next/server";
import { allocateSlot, audienceTz } from "@/lib/post-time";
import { publicAccounts } from "@/server/accounts";
import { queue, summary } from "@/server/queue";
import { effective } from "@/server/settings";

export const dynamic = "force-dynamic";

/** GET = every queue entry, the summary, and the next free slot for the connected platforms. */
export async function GET() {
  const entries = queue().list();
  const now = new Date();
  const platforms = publicAccounts().filter((a) => a.connected).map((a) => a.platform);
  const tz = audienceTz(effective().postingAudience);
  const taken = entries.filter((e) => (e.status === "scheduled" || e.status === "posting") && e.slotAt !== undefined).map((e) => ({ platform: e.platform, at: e.slotAt! }));
  const nextFree = platforms.length ? allocateSlot(taken, platforms, tz, now)?.getTime() : undefined;
  return NextResponse.json({ entries, summary: summary(entries, now), nextFree, audienceTz: tz });
}
