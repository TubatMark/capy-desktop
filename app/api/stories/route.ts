import { NextResponse } from "next/server";
import { z } from "zod";
import { stories } from "@/server/stories";
import { errorResponse } from "@/server/http";
import { listVoices } from "@/src/story/narrate";

export const dynamic = "force-dynamic";

let voices: Awaited<ReturnType<typeof listVoices>> | undefined;

/** GET = every series, plus the narration voices installed on this computer. */
export async function GET() {
  await stories().init();
  voices ??= await listVoices().catch(() => []);
  return NextResponse.json({ series: stories().listSeries(), voices });
}

const Body = z.strictObject({
  title: z.string().trim().min(1).max(80),
  ageBand: z.enum(["2-4", "5-8"]),
  tone: z.string().trim().max(200),
  values: z.array(z.string().trim().min(1).max(40)).max(8),
  artStyle: z.string().trim().max(300),
  characters: z.array(z.strictObject({ name: z.string().trim().min(1).max(40), description: z.string().trim().min(3).max(300) })).min(1).max(6),
});

/** POST = a new series; its characters are drawn in the background. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid series" }, { status: 400 });
  try {
    return NextResponse.json(await stories().createSeries(parsed.data));
  } catch (e) {
    return errorResponse(e);
  }
}
