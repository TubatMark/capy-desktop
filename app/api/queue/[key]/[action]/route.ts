import { deliveryForPackage, updateDelivery } from "@/server/delivery-store";
import { eligibility } from "@/server/publication-policy";
import { NextResponse } from "next/server";
import {
  postNow,
  queue,
  reject,
  retry,
  deliveryMutationReason,
  publicQueueEntry,
} from "@/server/queue";
import { tick } from "@/server/poster";

export const dynamic = "force-dynamic";

const ACTIONS = { reject, "post-now": postNow, retry } as const;

/** POST = reject | post-now | retry one entry. */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ key: string; action: string }> },
) {
  const { key: raw, action } = await ctx.params;
  const key = decodeURIComponent(raw);
  const fn = ACTIONS[action as keyof typeof ACTIONS];
  if (!fn && action !== "check-status")
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  const e = queue()
    .list()
    .find((x) => x.key === key);
  if (!e)
    return NextResponse.json({ error: "Not in the queue" }, { status: 404 });
  if (action === "check-status") {
    const delivery =
      e.publishPackage && deliveryForPackage(e.publishPackage.packageHash);
    if (!delivery)
      return NextResponse.json(
        { error: "No saved delivery to reconcile" },
        { status: 409 },
      );
    updateDelivery(delivery.id, (d) => ({ ...d, nextTryAt: Date.now() }));
    void tick().catch((err) => console.error("[poster]", err));
    return NextResponse.json(publicQueueEntry(e));
  }
  if (e.remoteSchedule && action !== "reject")
    return NextResponse.json(
      {
        error:
          "Use explicit remote schedule approval to change its bound publication time",
      },
      { status: 409 },
    );
  const deliveryBlock = deliveryMutationReason(e);
  if (deliveryBlock)
    return NextResponse.json({ error: deliveryBlock }, { status: 409 });
  if (e.status === "posting" || e.status === "posted")
    return NextResponse.json(
      { error: "Already posted or posting" },
      { status: 409 },
    );
  if (action !== "reject") {
    const result = eligibility(e);
    if (!result.allowed)
      return NextResponse.json(
        { error: result.reasons.join("; "), reasons: result.reasons },
        { status: 409 },
      );
  }
  if (action === "retry" && e.publishPackage) {
    const d = deliveryForPackage(e.publishPackage.packageHash);
    if (d)
      updateDelivery(d.id, (x) => ({
        ...x,
        state: "queued",
        nextTryAt: Date.now(),
        reason: undefined,
        retryClass: undefined,
      }));
  }
  const out = queue().mutate((all) => fn(all, key, new Date()));
  if (action !== "reject")
    void tick().catch((err) => console.error("[poster]", err));
  return NextResponse.json(publicQueueEntry(out.find((x) => x.key === key)!));
}
