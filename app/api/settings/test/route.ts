import { NextResponse } from "next/server";
import { testAgent } from "@/src/agents";
import { isAgentId, loadAppSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

/** POST { agent, model? } = send a tiny prompt to prove the AI is logged in and answering. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const agent: unknown = body.agent;
  if (!isAgentId(agent)) return NextResponse.json({ error: `Unknown AI "${agent}"` }, { status: 400 });
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : (await loadAppSettings()).models[agent];
  return NextResponse.json(await testAgent(agent, model));
}
