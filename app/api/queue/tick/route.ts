import { NextResponse } from "next/server";
import { startPoster, tick } from "@/server/poster";

export const dynamic = "force-dynamic";

// the header badge and the menu-bar icon call these on every page and every minute: make sure posting runs
startPoster();

/** POST = check for due posts now (the desktop app calls this when the computer wakes up). */
export async function POST() {
  void tick().catch((e) => console.error("[poster]", e));
  return NextResponse.json({ ok: true });
}
