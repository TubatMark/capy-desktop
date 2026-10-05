import { NextResponse } from "next/server";
import { checkNow } from "@/server/watcher";

export const dynamic = "force-dynamic";

/** POST = check every watched channel for new uploads now. */
export async function POST() {
  void checkNow().catch((e) => console.error("[watcher]", e));
  return NextResponse.json({ ok: true });
}
