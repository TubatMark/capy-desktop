import { NextResponse } from "next/server";
import { z } from "zod";
import { detectAgents } from "@/src/agents";
import { BROWSERS, loadSettings, redact, saveSettings } from "@/server/settings";
import { AGENT_IDS } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Partial merge body. Empty string clears a field (or one agent's model). Only these keys, only these shapes. */
const Patch = z.strictObject({
  agent: z.enum(AGENT_IDS).optional(),
  models: z.partialRecord(z.enum(AGENT_IDS), z.string().trim().max(200)).optional(),
  browser: z.enum(["", ...BROWSERS]).optional(),
  outputDir: z.string().trim().max(1024).optional(),
  claudeAuth: z.enum(["subscription", "apiKey"]).optional(),
  apiKey: z.string().trim().max(512).optional(),
  checkedAt: z.number().int().nonnegative().or(z.literal("")).optional(),
  audience: z.enum(["original", "en-us"]).optional(),
});

/** GET = saved settings (API key redacted) + every AI CLI found on this machine (?rescan=1 skips the cache). */
export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.has("rescan");
  const agents = await detectAgents(fresh);
  return NextResponse.json({ settings: redact(loadSettings()), agents });
}

/** PUT = merge the given fields into settings.json; returns { settings } redacted. */
export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = Patch.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid settings" }, { status: 400 });
  }
  const patch = { ...parsed.data };
  // the form echoes the redacted key back when the user did not type a new one: leave the stored key alone
  if (patch.apiKey?.startsWith("••••")) delete patch.apiKey;
  if (patch.agent && patch.agent !== "claude") {
    const found = (await detectAgents()).find((a) => a.id === patch.agent);
    if (!found?.installed) return NextResponse.json({ error: `${found?.name ?? patch.agent} is not installed on this machine` }, { status: 400 });
  }
  try {
    return NextResponse.json({ settings: redact(saveSettings(patch)) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
