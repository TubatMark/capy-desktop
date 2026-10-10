import { NextResponse } from "next/server";
import { z } from "zod";
import { saveCreatorPolicy } from "@/server/automation-policy";
import { loadSettings } from "@/server/settings";
import { mapChannel, watch } from "@/server/watch";

export const dynamic = "force-dynamic";

const Patch = z.strictObject({
  enabled: z.boolean().optional(),
  settings: z
    .strictObject({
      clips: z.number().int().min(1).max(10),
      minVideoSec: z.number().int().min(60).max(7200),
      perDay: z.number().int().min(1).max(10),
      audience: z.enum(["original", "en-us"]).optional(),
    })
    .optional(),
});

/** PATCH { enabled?, settings? } */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  if (!watch().get().channels.some((c) => c.id === id)) return NextResponse.json({ error: "Not watched" }, { status: 404 });
  const next = parsed.data.settings;
  // A saved creator policy wins over the card's settings when clipping, so keep the two in step.
  const saved = loadSettings().creatorPolicies?.[id];
  if (next && saved && (saved.clips !== next.clips || saved.minDurationSec !== next.minVideoSec)) {
    try {
      saveCreatorPolicy(id, { ...saved, clips: next.clips, minDurationSec: next.minVideoSec, maxDurationSec: Math.max(saved.maxDurationSec, next.minVideoSec) });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }
  const f = watch().mutate((w) => mapChannel(w, id, (c) => ({ ...c, ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}), ...(next ? { settings: next } : {}) })));
  return NextResponse.json(f.channels.find((c) => c.id === id));
}

/** DELETE = stop watching (videos and clips already made stay). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!watch().get().channels.some((c) => c.id === id)) return NextResponse.json({ error: "Not watched" }, { status: 404 });
  watch().mutate((w) => ({ ...w, channels: w.channels.filter((c) => c.id !== id) }));
  return NextResponse.json({ ok: true });
}
