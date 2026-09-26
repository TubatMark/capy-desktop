import { NextResponse } from "next/server";
import { jobs } from "@/server/jobs";
import { FORBIDDEN, getAccess } from "@/server/access";

export const dynamic = "force-dynamic";

export async function GET() {
  const m = jobs();
  await m.init();
  return NextResponse.json(m.list());
}

export async function POST(req: Request) {
  const access = await getAccess(req);
  if (!access.can.createJob) return NextResponse.json(FORBIDDEN, { status: 403 });
  const body = await req.json().catch(() => ({}));
  try {
    const job = await jobs().create(String(body.url ?? ""), body.settings ?? {});
    return NextResponse.json(job);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
