import { NextResponse } from "next/server";
import { postNow, queue, reject, retry } from "@/server/queue";
import { tick } from "@/server/poster";

export const dynamic = "force-dynamic";

const ACTIONS = { reject, "post-now": postNow, retry } as const;

/** POST = reject | post-now | retry one entry. */
export async function POST(_req: Request, ctx: { params: Promise<{ key: string; action: string }> }) {
  const { key: raw, action } = await ctx.params;
  const key = decodeURIComponent(raw);
  const fn = ACTIONS[action as keyof typeof ACTIONS];
  if (!fn) return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  const e = queue().list().find((x) => x.key === key);
  if (!e) return NextResponse.json({ error: "Not in the queue" }, { status: 404 });
  if (e.status === "posting" || e.status === "posted") return NextResponse.json({ error: "Already posted or posting" }, { status: 409 });
  const out = queue().mutate((all) => fn(all, key, new Date()));
  if (action !== "reject") void tick().catch((err) => console.error("[poster]", err));
  return NextResponse.json(out.find((x) => x.key === key));
}
