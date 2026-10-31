import { NextResponse } from "next/server";
import { currentTasks } from "@/server/todo";

export const dynamic = "force-dynamic";

/** GET = what's waiting for the user. */
export async function GET() {
  return NextResponse.json({ tasks: await currentTasks() });
}
