import { NextResponse } from "next/server";
import { queue, summary } from "@/server/queue";
import { effective } from "@/server/settings";

export const dynamic = "force-dynamic";

/** GET = review count and next post (header badge, menu-bar icon). */
export async function GET() {
  return NextResponse.json({ ...summary(queue().list(), new Date()), paused: effective().postingPaused });
}
