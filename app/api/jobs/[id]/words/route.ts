import { NextResponse } from "next/server";
import { jobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const m = jobs();
  await m.init();
  const job = m.get(id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    return NextResponse.json(await m.getWords(job));
  } catch {
    return NextResponse.json([]);
  }
}
