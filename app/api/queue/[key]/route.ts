import { eligibility } from "@/server/publication-policy";
import { NextResponse } from "next/server";
import { z } from "zod";
import { audienceTz } from "@/lib/post-time";
import { editText, move, queue, remove } from "@/server/queue";
import { effective } from "@/server/settings";

export const dynamic = "force-dynamic";

const Patch = z.strictObject({
  text: z.strictObject({ title: z.string().max(100).optional(), description: z.string().max(5000).optional(), tags: z.array(z.string().max(100)).max(60).optional(), caption: z.string().max(2200).optional() }).optional(),
  slotAt: z.number().int().positive().optional(),
});

/** PATCH { text?, slotAt? } = edit the post text, or move it to another time. */
export async function PATCH(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const key = decodeURIComponent((await ctx.params).key);
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  const e = queue().list().find((x) => x.key === key);
  if (!e) return NextResponse.json({ error: "Not in the queue" }, { status: 404 });
  if (e.status === "posting" || e.status === "posted") return NextResponse.json({ error: "Already posted or posting" }, { status: 409 });
  if (parsed.data.slotAt) {
    const candidate = parsed.data.text ? {...e,text:{...e.text,...parsed.data.text}} : e;
    const result = eligibility(candidate);
    if (!result.allowed) return NextResponse.json({error:result.reasons.join("; "), reasons:result.reasons},{status:409});
  }
  const now = new Date();
  const out = queue().mutate((all) => {
    let next = all;
    if (parsed.data.text) next = editText(next, key, parsed.data.text, now);
    if (parsed.data.slotAt) next = move(next, key, parsed.data.slotAt, now, audienceTz(effective().postingAudience));
    return next;
  });
  return NextResponse.json(out.find((x) => x.key === key));
}

/** DELETE = take it out of the queue (nothing is removed from the platform). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  const key = decodeURIComponent((await ctx.params).key);
  const e = queue().list().find((x) => x.key === key);
  if (!e) return NextResponse.json({ error: "Not in the queue" }, { status: 404 });
  if (e.status === "posting") return NextResponse.json({ error: "It's uploading right now" }, { status: 409 });
  queue().mutate((all) => remove(all, key));
  return NextResponse.json({ ok: true });
}
