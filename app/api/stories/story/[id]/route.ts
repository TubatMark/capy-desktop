import { NextResponse } from "next/server";
import { z } from "zod";
import { stories } from "@/server/stories";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET = the story and its series (for the cast). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await stories().init();
  const story = stories().getStory(id);
  if (!story) return NextResponse.json({ error: "Story not found" }, { status: 404 });
  return NextResponse.json({ story, series: stories().getSeries(story.seriesId) });
}

const Cast = z.strictObject({ id: z.string().max(40), x: z.number().min(0).max(1), y: z.number().min(0).max(1).optional(), scale: z.number().min(0.5).max(3).optional(), flip: z.boolean().optional() });
const Patch = z.strictObject({
  title: z.string().trim().max(100).optional(),
  pages: z.array(z.strictObject({ text: z.string().trim().min(1).max(400), scene: z.string().trim().max(600), cast: z.array(Cast).max(3) })).min(1).max(12).optional(),
});

/** PATCH { title?, pages? } = the user's edits to the script. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid edit" }, { status: 400 });
  await stories().init();
  try {
    return NextResponse.json(await stories().updateStory(id, parsed.data));
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE = remove the story and its files (anything already posted stays posted). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await stories().init();
  try {
    await stories().deleteStory(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
