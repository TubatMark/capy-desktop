import { NextResponse } from "next/server";
import { z } from "zod";
import { stories } from "@/server/stories";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

const Body = z.strictObject({ brief: z.string().trim().min(3).max(500) });

/** POST { brief } = write a new story (writer, then the kid-safety reviewer) in the background. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Describe the story in a sentence" }, { status: 400 });
  await stories().init();
  try {
    return NextResponse.json(await stories().createStory(id, parsed.data.brief));
  } catch (e) {
    return errorResponse(e);
  }
}
