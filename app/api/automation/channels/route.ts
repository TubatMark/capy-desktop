import { NextResponse } from "next/server";
import { z } from "zod";
import { listUploads, resolveChannel } from "@/src/youtube";
import { effective } from "@/server/settings";
import { addChannel, watch } from "@/server/watch";
import { kickWatcher } from "@/server/watcher";

export const dynamic = "force-dynamic";

const Body = z.strictObject({ input: z.string().trim().min(1).max(300), clipLatest: z.boolean().optional() });

/** POST { input, clipLatest? } = start watching a channel (URL, @handle, or one of its videos). */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Paste a channel link or @handle" }, { status: 400 });
  const yt = { cookiesFromBrowser: effective().browser, proxy: process.env.YT_PROXY };
  try {
    const info = await resolveChannel(parsed.data.input, yt);
    if (watch().get().channels.some((c) => c.id === info.id)) return NextResponse.json({ error: `${info.name} is already watched` }, { status: 409 });
    const uploads = await listUploads(info.url, 12, yt);
    const f = watch().mutate((w) => addChannel(w, info, uploads, { now: new Date(), clipLatest: parsed.data.clipLatest }));
    if (parsed.data.clipLatest) kickWatcher();
    return NextResponse.json(f.channels.find((c) => c.id === info.id));
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return NextResponse.json({ error: (e instanceof Error ? e.message : String(e)).split("\n").pop() }, { status });
  }
}
