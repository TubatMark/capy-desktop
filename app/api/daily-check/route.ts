import { NextResponse } from "next/server";
import { loadDailyReport, loadTuning, runDailyCheck } from "@/server/daily-check";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

/** GET = the latest daily check on posted videos. */
export async function GET() {
  return NextResponse.json({ report: loadDailyReport() ?? null, tuning: loadTuning() });
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
