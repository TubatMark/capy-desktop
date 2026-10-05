import { NextResponse } from "next/server";
import { startPoster } from "@/server/poster";
import { queue, summary } from "@/server/queue";
import { watch } from "@/server/watch";
import { startWatcher } from "@/server/watcher";
import { effective } from "@/server/settings";

export const dynamic = "force-dynamic";

// the header badge and the menu-bar icon call these on every page and every minute: make sure posting runs
startPoster();
startWatcher();

/** GET = review count and next post (header badge, menu-bar icon). */
export async function GET() {
  const watching = watch().get().channels.filter((c) => c.enabled).length;
  return NextResponse.json({ ...summary(queue().list(), new Date()), paused: effective().postingPaused, watching });
}
