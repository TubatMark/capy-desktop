import { NextResponse } from "next/server";
import { finishConnect } from "@/server/connect";
import { publicAccounts } from "@/server/accounts";
import { PLATFORMS, type Platform } from "@/lib/types";

export const dynamic = "force-dynamic";

/** POST { url } = finish signing in from the address the user copied out of their browser. */
export async function POST(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!(PLATFORMS as string[]).includes(platform)) return NextResponse.json({ error: "Unknown platform" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (typeof body.url !== "string") return NextResponse.json({ error: "Paste the address from your browser" }, { status: 400 });
  try {
    await finishConnect(platform as Platform, body.url);
    return NextResponse.json(publicAccounts().find((a) => a.platform === platform));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
