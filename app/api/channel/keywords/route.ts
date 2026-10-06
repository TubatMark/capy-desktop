import { NextResponse } from "next/server";
import { research } from "@/server/seo";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET ?q= = keyword research for a topic (autocomplete, what ranks, the channel's own searches). */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 80) return NextResponse.json({ error: "Type a topic (2–80 characters)" }, { status: 400 });
  try {
    return NextResponse.json(await research(q));
  } catch (e) {
    return errorResponse(e);
  }
}
