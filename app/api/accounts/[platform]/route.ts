import { NextResponse } from "next/server";
import { z } from "zod";
import { loadAccounts, publicAccounts, saveAccount } from "@/server/accounts";
import { queue, reconnected } from "@/server/queue";
import { effective } from "@/server/settings";
import { audienceTz } from "@/lib/post-time";
import { PLATFORMS, type Platform } from "@/lib/types";

export const dynamic = "force-dynamic";

const Patch = z.strictObject({
  clientId: z.string().trim().max(300).optional(),
  clientSecret: z.string().trim().max(300).optional(),
  autoPost: z.boolean().optional(),
  mode: z.enum(["inbox", "direct"]).optional(),
  igUserId: z.string().trim().max(64).optional(),
});

const isPlatform = (p: string): p is Platform => (PLATFORMS as string[]).includes(p);

/** PUT = save this platform's app credentials and options. */
export async function PUT(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!isPlatform(platform)) return NextResponse.json({ error: "Unknown platform" }, { status: 404 });
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  const patch: Parameters<typeof saveAccount>[1] = { ...parsed.data };
  // the form echoes the redacted secret back when the user didn't type a new one
  if (patch.clientSecret?.startsWith("••••")) delete patch.clientSecret;
  if (patch.igUserId !== undefined) {
    const choice = loadAccounts().instagram.choices?.find((c) => c.id === patch.igUserId);
    if (!choice) return NextResponse.json({ error: "Unknown Instagram account" }, { status: 400 });
    patch.account = choice;
  }
  saveAccount(platform, patch);
  // posts that waited for an Instagram account to be picked can go now
  if (patch.igUserId) queue().mutate((e) => reconnected(e, platform, audienceTz(effective().postingAudience), new Date()));
  return NextResponse.json(publicAccounts().find((a) => a.platform === platform));
}

/** DELETE = disconnect: forget the tokens and the signed-in account, keep the app credentials. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!isPlatform(platform)) return NextResponse.json({ error: "Unknown platform" }, { status: 404 });
  saveAccount(platform, { tokens: null, account: null, needsReconnect: null, choices: null, igUserId: null });
  return NextResponse.json(publicAccounts().find((a) => a.platform === platform));
}
