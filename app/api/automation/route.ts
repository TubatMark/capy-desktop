import { NextResponse } from "next/server";
import { z } from "zod";
import { watch } from "@/server/watch";
import { publicAccounts } from "@/server/accounts";
import { isChecking } from "@/server/watcher";

export const dynamic = "force-dynamic";

/** GET = watched channels, the check interval and daily cap, and whether a check is running. */
export async function GET() {
  // without a connected posting account, automation's clips can't reach Queue: the page says so
  const postingReady = publicAccounts().some((a) => a.connected && a.autoPost);
  return NextResponse.json({
    ...watch().get(),
    checking: isChecking(),
    postingReady,
  });
}

const Put = z.strictObject({
  intervalMin: z.number().int().min(15).max(1440).optional(),
  maxPerDay: z.number().int().min(1).max(30).optional(),
});

/** PUT { intervalMin?, maxPerDay? } */
export async function PUT(req: Request) {
  const parsed = Put.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  return NextResponse.json(watch().mutate((f) => ({ ...f, ...parsed.data })));
}
