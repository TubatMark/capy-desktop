import { NextResponse } from "next/server";
import { channelState } from "@/server/channel";

export const dynamic = "force-dynamic";

/** GET = the channel snapshot (refreshed when stale, or with ?refresh=1) and what the connection allows. */
export async function GET(req: Request) {
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  return NextResponse.json(await channelState({ refresh }));
}
