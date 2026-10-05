import { NextResponse } from "next/server";
import { startPoster } from "@/server/poster";
import { queue, summary } from "@/server/queue";
import { effective } from "@/server/settings";

export const dynamic = "force-dynamic";

// the header badge and the menu-bar icon call these on every page and every minute: make sure posting runs
startPoster();

/** GET = review count and next post (header badge, menu-bar icon). */
export async function GET() {
  return NextResponse.json({ ...summary(queue().list(), new Date()), paused: effective().postingPaused });
}
