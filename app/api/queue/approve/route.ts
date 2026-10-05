import { NextResponse } from "next/server";
import { z } from "zod";
import { audienceTz } from "@/lib/post-time";
import { approve, queue } from "@/server/queue";
import { effective } from "@/server/settings";
import { PLATFORMS, type QueueEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

const Body = z.strictObject({
  jobId: z.string().min(1).max(64),
  n: z.number().int().positive().optional(),
  platforms: z.array(z.enum(PLATFORMS as [string, ...string[]])).optional(),
  /** The user confirmed posting clips the AI reviewer blocked. */
  force: z.boolean().optional(),
});

/** POST { jobId, n?, platforms? } = approve one clip (or the whole video) and give it the next free slot. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  const { jobId, n, platforms, force } = parsed.data;
  const waiting = queue()
    .list()
    .filter((e) => e.jobId === jobId && e.status === "review" && (n === undefined || e.n === n));
  if (!waiting.length) return NextResponse.json({ error: "Nothing from that video is waiting for review" }, { status: 404 });
  if (!force && waiting.some((e) => e.aiReview?.verdict === "block")) {
    return NextResponse.json({ error: "The AI reviewer blocked a clip here. Confirm to post it anyway.", blocked: true }, { status: 409 });
  }
  let scheduled: QueueEntry[] = [];
  queue().mutate((e) => {
    const r = approve(e, jobId, n, { platforms: platforms as QueueEntry["platform"][] | undefined, audienceTz: audienceTz(effective().postingAudience), now: new Date() });
    scheduled = r.scheduled;
    return r.entries;
  });
  return NextResponse.json({ scheduled });
}
