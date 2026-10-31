import { NextResponse } from "next/server";
import { z } from "zod";
import { liveTimes, recommendSlot, slotResults } from "@/lib/longform";
import { errorResponse } from "@/server/http";
import { setNarration, shortTestReport } from "@/server/shorts-test";
import { queueStep } from "@/server/longform/queue";
import { availableClips, createVideo, footageByCreator, listVideos, loadAudience, loadAutopilot, loadAutopilotLog, loadSlots, saveAutopilot, saveSlots } from "@/server/longform/store";
import { viewsLookup } from "@/server/longform/worker";

export const dynamic = "force-dynamic";

/**
 * GET = the board: every long video, who watches, upload slots and how they're doing. The board polls this, so the rest
 * has its own params: ?footage=1 for footage per creator (walks every clip), ?automation=1 for the switches and the
 * narrated Shorts results.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    if (params.has("footage")) return NextResponse.json({ footage: footageByCreator(availableClips(await viewsLookup())) });
    if (params.has("automation")) return NextResponse.json({ shortsTest: shortTestReport(), autopilot: loadAutopilot(), autopilotLog: loadAutopilotLog() });
    const videos = listVideos();
    const slots = loadSlots();
    const taken = videos.filter((v) => v.slotAt).map((v) => ({ at: v.slotAt!, slotId: v.slotId }));
    return NextResponse.json({
      videos,
      audience: loadAudience() ?? null,
      slots,
      recommended: recommendSlot(slots, taken, Date.now()),
      results: slotResults(slots, videos),
      live: liveTimes(videos, slots, Date.now()),
      autopilot: loadAutopilot(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("shorts-test"), mode: z.enum(["auto", "all", "half", "off"]) }),
  z.strictObject({
    action: z.literal("autopilot"),
    settings: z.strictObject({ draft: z.boolean(), upload: z.boolean(), publish: z.boolean(), free: z.boolean() }),
  }),
  z.strictObject({ action: z.literal("create"), creator: z.string().min(1).max(100) }),
  z.strictObject({
    action: z.literal("slots"),
    slots: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(40),
          day: z.number().int().min(0).max(6),
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
          label: z.string().min(1).max(40),
        }),
      )
      .min(1)
      .max(7),
  }),
]);

/** POST = start a long video from a creator's footage, or change the upload slots. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  try {
    if (parsed.data.action === "shorts-test") {
      setNarration(parsed.data.mode);
      return NextResponse.json({ ok: true });
    }
    if (parsed.data.action === "autopilot") {
      saveAutopilot(parsed.data.settings);
      return NextResponse.json({ ok: true });
    }
    if (parsed.data.action === "slots") {
      saveSlots(parsed.data.slots);
      return NextResponse.json({ ok: true });
    }
    const video = createVideo(parsed.data.creator, await viewsLookup());
    await queueStep({ id: video.id, step: "plan" });
    return NextResponse.json(video);
  } catch (e) {
    return errorResponse(e);
  }
}
