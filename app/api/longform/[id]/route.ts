import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/server/http";
import { startUpload } from "@/server/longform/autopilot";
import { cleanupPlan, freeSpace } from "@/server/longform/cleanup";
import { queueStep } from "@/server/longform/queue";
import { getVideo, patchVideo, removeVideo } from "@/server/longform/store";
import { setPublishTime } from "@/server/longform/youtube";
import { ytDeps } from "@/server/longform/worker";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET = one video, and what freeing its space would remove. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = getVideo(id);
  if (!video) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ video, cleanup: cleanupPlan(video) });
}

const Body = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("text"), title: z.string().trim().min(1).max(100), description: z.string().max(5000) }),
  z.strictObject({ action: z.literal("upload") }),
  z.strictObject({ action: z.literal("retry") }),
  z.strictObject({ action: z.literal("recheck") }),
  z.strictObject({ action: z.literal("schedule"), at: z.number().int().positive(), slotId: z.string().max(40).optional() }),
  z.strictObject({ action: z.literal("unschedule") }),
  z.strictObject({ action: z.literal("free") }),
  z.strictObject({ action: z.literal("manual"), on: z.boolean() }),
]);

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const video = getVideo(id);
  if (!video) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = parsed.data;
  try {
    switch (body.action) {
      case "manual":
        return NextResponse.json(patchVideo(id, { manual: body.on }));
      case "text":
        if (video.youtube?.id) return NextResponse.json({ error: "It's already on YouTube; edit it in YouTube Studio" }, { status: 409 });
        return NextResponse.json(patchVideo(id, { title: body.title, description: body.description }));
      case "upload":
        // the owner's approval: nothing reaches YouTube without this
        if (video.status !== "review" || !video.master) return NextResponse.json({ error: "Only a finished video in review can be uploaded" }, { status: 409 });
        startUpload(id);
        await queueStep({ id, step: "upload" });
        return NextResponse.json(getVideo(id));
      case "retry":
        if (!video.failedStep) return NextResponse.json({ error: "Nothing to retry" }, { status: 409 });
        await queueStep({ id, step: video.failedStep, index: video.failedIndex });
        return NextResponse.json(patchVideo(id, { error: undefined, failedStep: undefined, failedIndex: undefined, step: "Trying again" }));
      case "recheck":
        if (video.status !== "review" || !video.master) return NextResponse.json({ error: "Only a finished video in review can be checked again" }, { status: 409 });
        await queueStep({ id, step: "check" });
        return NextResponse.json(video);
      case "schedule": {
        if (!video.youtube?.id || !video.youtube.processedAt) return NextResponse.json({ error: "It has to finish processing on YouTube first" }, { status: 409 });
        if (video.youtube.publishedAt) return NextResponse.json({ error: "It's already public" }, { status: 409 });
        if (body.at < Date.now() + 15 * 60_000) return NextResponse.json({ error: "Pick a time at least 15 minutes away" }, { status: 400 });
        await setPublishTime(await ytDeps(), video.youtube.id, body.at);
        return NextResponse.json(patchVideo(id, { status: video.status === "freed" ? "freed" : "scheduled", slotAt: body.at, slotId: body.slotId, manual: true }));
      }
      case "unschedule":
        if (!video.youtube?.id || video.youtube.publishedAt) return NextResponse.json({ error: "There's no schedule to cancel" }, { status: 409 });
        await setPublishTime(await ytDeps(), video.youtube.id, null);
        // the owner decided: the autopilot mustn't just book it again
        return NextResponse.json(patchVideo(id, { status: video.status === "freed" ? "freed" : "private", slotAt: undefined, slotId: undefined, manual: true }));
      case "free":
        return NextResponse.json(freeSpace(id));
    }
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE = drop a video that never reached YouTube. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = getVideo(id);
  if (!video) return NextResponse.json({ ok: true });
  if (video.youtube?.id || video.youtube?.session) return NextResponse.json({ error: "It's already on YouTube" }, { status: 409 });
  if (!["draft", "review"].includes(video.status) && !video.error) return NextResponse.json({ error: "Wait for the current step to finish" }, { status: 409 });
  removeVideo(id);
  return NextResponse.json({ ok: true });
}
