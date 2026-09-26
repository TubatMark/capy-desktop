import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { jobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** Reveal the job's output folder in Finder (macOS `open -R`). Works from the browser and the desktop app. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const m = jobs();
  await m.init();
  const job = m.get(id);
  if (!job) return NextResponse.json({ error: "No such job" }, { status: 404 });
  if (process.platform !== "darwin") return NextResponse.json({ error: "Reveal is only supported on macOS" }, { status: 501 });
  spawn("open", ["-R", job.dir], { stdio: "ignore", detached: true }).unref();
  return NextResponse.json({ ok: true });
}
