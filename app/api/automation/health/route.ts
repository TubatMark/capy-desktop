import { z } from "zod";
import {
  AutomationControlsSchema,
  CreatorPolicySchema,
} from "@/lib/creator-policy";
import { automationHealth } from "@/server/worker/health";
import { saveCreatorPolicy } from "@/server/automation-policy";
import { saveSettings } from "@/server/settings";
import { watch } from "@/server/watch";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await automationHealth());
}
const Patch = z.union([
  z.strictObject({ controls: AutomationControlsSchema }),
  z.strictObject({
    channelId: z.string().min(1).max(200),
    policy: CreatorPolicySchema,
  }),
]);
export async function PUT(request: Request) {
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid policy" },
      { status: 400 },
    );
  try {
    if ("controls" in parsed.data)
      saveSettings({
        automationControls: parsed.data.controls,
        postingPaused: parsed.data.controls.postPaused,
      });
    else {
      const channelId = parsed.data.channelId;
      if (
        !watch()
          .get()
          .channels.some((c) => c.id === channelId)
      )
        return Response.json({ error: "Creator not found" }, { status: 404 });
      saveCreatorPolicy(parsed.data.channelId, parsed.data.policy);
    }
    return Response.json(await automationHealth());
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Could not save policy",
      },
      { status: 400 },
    );
  }
}
