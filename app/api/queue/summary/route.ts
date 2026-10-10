import { NextResponse } from "next/server";
import { queue, summary } from "@/server/queue";
import { watch } from "@/server/watch";
import { effective } from "@/server/settings";
import { currentTasks } from "@/server/todo";

export const dynamic = "force-dynamic";

/** GET = review count and next post (header badge, menu-bar icon). */
export async function GET() {
  const watching = watch()
    .get()
    .channels.filter((c) => c.enabled).length;
  const todo = (await currentTasks().catch(() => [])).length;
  return NextResponse.json({
    ...summary(queue().list(), new Date()),
    paused: effective().postingPaused,
    watching,
    todo,
  });
}
