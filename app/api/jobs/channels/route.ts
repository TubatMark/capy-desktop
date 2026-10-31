import { NextResponse } from "next/server";
import { jobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** GET = the YouTube channel each source video came from, by job id: all the Short form page needs from jobs. */
export async function GET() {
  const m = jobs();
  await m.init();
  const channels: Record<string, string> = {};
  for (const j of m.list()) {
    const name = j.channel ?? j.automation?.channelName;
    if (name) channels[j.id] = name;
  }
  return NextResponse.json({ channels });
}
