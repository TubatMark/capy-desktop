import { queueGroup } from "@/lib/queue-source";
import { resolvePublicationFiles } from "@/server/poster";
import { decide, eligibility, hashManifest } from "@/server/publication-policy";
import { NextResponse } from "next/server";
import { z } from "zod";
import { audienceTz } from "@/lib/post-time";
import { approve, queue } from "@/server/queue";
import { effective } from "@/server/settings";
import { PLATFORMS, type QueueEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

const Body = z.strictObject({
  jobId: z.string().min(1).max(64).optional(),
  group: z.string().min(1).max(256).optional(),
  n: z.number().int().positive().optional(),
  platforms: z.array(z.enum(PLATFORMS as [string, ...string[]])).optional(),
  /** The user confirmed posting clips the AI reviewer blocked. */
  force: z.boolean().optional(),
});

/** POST { jobId, n?, platforms? } = approve one clip (or the whole video) and give it the next free slot. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  const { jobId, group, n, platforms, force } = parsed.data;
  if ((!jobId && !group) || (jobId && group)) return NextResponse.json({error:"Select one queue source"},{status:400});
  const waiting = queue()
    .list()
    .filter((e) => (group ? queueGroup(e)===group : !e.source && e.jobId === jobId && (n === undefined || e.n === n)) && e.status === "review");
  if (!waiting.length) return NextResponse.json({ error: "Nothing from that video is waiting for review" }, { status: 404 });
  if (!force && waiting.some((e) => e.aiReview?.verdict === "block")) {
    return NextResponse.json({ error: "The AI reviewer blocked a clip here. Confirm to post it anyway.", blocked: true }, { status: 409 });
  }
  const candidates = waiting.filter(e => !platforms || platforms.includes(e.platform));
  const prepared = await Promise.all(candidates.map(async e => {
    const files = await resolvePublicationFiles(e);
    return decide({...e,publicationFiles:typeof files === "object" ? files : undefined}, !!force, new Date());
  }));
  if (candidates.some(original => {
    const current = queue().list().find(e => e.key === original.key);
    return !current || hashManifest(current) !== hashManifest(original);
  })) return NextResponse.json({error:"Queue changed during review; retry approval"}, {status:409});
  const denied = prepared.flatMap(e => eligibility(e).reasons);
  if (denied.length) return NextResponse.json({error:denied.join("; "), reasons:denied}, {status:409});
  let scheduled: QueueEntry[] = [];
  queue().mutate((e) => {
    const ready = e.map(x=>prepared.find(p=>p.key===x.key) ?? x);
    const r = approve(ready, jobId ?? "", n, { group, override: !!force, platforms: platforms as QueueEntry["platform"][] | undefined, audienceTz: audienceTz(effective().postingAudience), now: new Date() });
    scheduled = r.scheduled;
    return r.entries;
  });
  return NextResponse.json({ scheduled });
}
