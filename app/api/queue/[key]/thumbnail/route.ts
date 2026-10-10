import { NextResponse } from "next/server";
import { z } from "zod";
import { publicQueueEntry } from "@/server/queue";
import { switchQueueThumbnail } from "@/server/thumbnail-studio";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

const Body = z.strictObject({ designId: z.string().min(1).max(200) });

/** POST { designId } = upload this clip design (one of the entry's thumbnailOptions) with the post. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ key: string }> },
) {
  const key = decodeURIComponent((await ctx.params).key);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "Choose a thumbnail" }, { status: 400 });
  try {
    return NextResponse.json(
      publicQueueEntry(await switchQueueThumbnail(key, parsed.data.designId)),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
