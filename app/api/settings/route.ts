import { NextResponse } from "next/server";
import { detectAgents } from "@/src/agents";
import { isAgentId, loadAppSettings, saveAppSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

/** GET = saved settings + every AI CLI found on this machine (?rescan=1 skips the cache). */
export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.has("rescan");
  const [settings, agents] = await Promise.all([loadAppSettings(), detectAgents(fresh)]);
  return NextResponse.json({ settings, agents });
}

/** PUT = save { agent?, models? }. */
export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body.agent !== undefined && !isAgentId(body.agent)) return NextResponse.json({ error: `Unknown AI "${body.agent}"` }, { status: 400 });
  if (body.agent && body.agent !== "claude") {
    const found = (await detectAgents()).find((a) => a.id === body.agent);
    if (!found?.installed) return NextResponse.json({ error: `${found?.name ?? body.agent} is not installed on this machine` }, { status: 400 });
  }
  return NextResponse.json({ settings: await saveAppSettings({ agent: body.agent, models: body.models }) });
}
