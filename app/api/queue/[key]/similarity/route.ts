import { NextResponse } from "next/server";
import { publicQueueEntry, queue } from "@/server/queue";
import { requestSimilarityCheck } from "@/server/similarity";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

/** POST = "Check again": ask both AIs again whether this clip looks like the others (runs in the background). */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ key: string }> },
) {
  const key = decodeURIComponent((await ctx.params).key);
  const e = queue()
    .list()
    .find((x) => x.key === key);
  if (!e)
    return NextResponse.json({ error: "Not in the queue" }, { status: 404 });
  if (e.status !== "review")
    return NextResponse.json(
      { error: "Only clips waiting for your OK are compared" },
      { status: 409 },
    );
  try {
    await requestSimilarityCheck(e);
    return NextResponse.json(publicQueueEntry(e), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
