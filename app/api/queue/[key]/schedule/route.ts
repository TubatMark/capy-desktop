import { NextResponse } from "next/server";
import {
  approveRemoteSchedule,
  RemoteScheduleInput,
} from "@/server/delivery-schedule";
export async function POST(
  req: Request,
  ctx: { params: Promise<{ key: string }> },
) {
  const parsed = RemoteScheduleInput.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success)
    return NextResponse.json(
      {
        error:
          "Choose an exact time and explicitly acknowledge the remote schedule",
      },
      { status: 400 },
    );
  try {
    return NextResponse.json(
      approveRemoteSchedule(
        decodeURIComponent((await ctx.params).key),
        parsed.data,
      ),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Remote scheduling failed",
      },
      { status: 409 },
    );
  }
}
