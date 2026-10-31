import { NextResponse } from "next/server";
import { z } from "zod";
import { loadDailyReport, loadTuning, runDailyCheck, saveFocusCreators } from "@/server/daily-check";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET = the latest daily check on posted videos. */
export async function GET() {
  return NextResponse.json({ report: loadDailyReport() ?? null, tuning: loadTuning() });
}

const Focus = z.strictObject({ focusCreators: z.array(z.string().min(1).max(100)).max(20) });

/** PUT = which creators get priority: the daily check's focus test. */
export async function PUT(req: Request) {
  const parsed = Focus.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid list of creators" }, { status: 400 });
  saveFocusCreators(parsed.data.focusCreators);
  return NextResponse.json({ tuning: loadTuning() });
}

/** POST = check now rather than waiting for tomorrow's. */
export async function POST() {
  try {
    const report = await runDailyCheck();
    if (!report) return NextResponse.json({ error: "Connect YouTube in Settings first." }, { status: 409 });
    return NextResponse.json({ report, tuning: loadTuning() });
  } catch (e) {
    return errorResponse(e);
  }
}
