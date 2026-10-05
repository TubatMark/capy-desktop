import { NextResponse } from "next/server";
import { startConnect } from "@/server/connect";
import { PLATFORMS, type Platform } from "@/lib/types";

export const dynamic = "force-dynamic";

/** POST = start signing in: returns the authorize URL to open in the browser; the loopback waits for the redirect. */
export async function POST(_req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!(PLATFORMS as string[]).includes(platform)) return NextResponse.json({ error: "Unknown platform" }, { status: 404 });
  try {
    return NextResponse.json(await startConnect(platform as Platform));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
