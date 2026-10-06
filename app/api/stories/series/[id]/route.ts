import { NextResponse } from "next/server";
import { stories } from "@/server/stories";

export const dynamic = "force-dynamic";

/** GET = the series and its stories. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await stories().init();
  const series = stories().getSeries(id);
  if (!series) return NextResponse.json({ error: "Series not found" }, { status: 404 });
  return NextResponse.json({ series, stories: stories().listStories(id) });
}
