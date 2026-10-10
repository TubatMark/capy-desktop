import { NextResponse } from "next/server";
import { tick } from "@/server/poster";

export const dynamic = "force-dynamic";

/** POST = check for due posts now (the desktop app calls this when the computer wakes up). */
export async function POST() {
  await tick();
  return NextResponse.json({ ok: true });
}
