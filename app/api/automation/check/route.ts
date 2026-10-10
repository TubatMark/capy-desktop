import { NextResponse } from "next/server";
import { checkNow } from "@/server/watcher";

export const dynamic = "force-dynamic";

/** POST = check every watched channel for new uploads now. */
export async function POST() {
  await checkNow();
  return NextResponse.json({ ok: true });
}
