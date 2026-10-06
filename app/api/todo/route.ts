import { NextResponse } from "next/server";
import { currentTasks } from "@/server/todo";
import { stories } from "@/server/stories";

export const dynamic = "force-dynamic";

/** GET = what's waiting for the user, and how many stories the assessor is still looking at. */
export async function GET() {
  const tasks = await currentTasks();
  const assessing = [...stories().stories.values()].filter((s) => s.assessing).map((s) => ({ id: s.id, seriesId: s.seriesId, title: s.title, stage: s.assessing! }));
  return NextResponse.json({ tasks, assessing, waiting: stories().assessor.size });
}
