import { NextResponse } from "next/server";
import { z } from "zod";
import { BROWSERS, loadSettings, redact, saveSettings } from "@/server/settings";
import { MODELS } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Partial merge body. Empty string clears a field. Only these keys, only these shapes. */
const Patch = z.strictObject({
  browser: z.enum(["", ...BROWSERS]).optional(),
  outputDir: z.string().trim().max(1024).optional(),
  model: z.string().trim().max(120).optional(),
  claudeAuth: z.enum(["subscription", "apiKey"]).optional(),
  apiKey: z.string().trim().max(512).optional(),
  checkedAt: z.number().int().nonnegative().or(z.literal("")).optional(),
});

/** Settings with the API key redacted. */
export async function GET() {
  return NextResponse.json(redact(loadSettings()));
}

/** Merge the given fields into settings.json and return the redacted result. */
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
  if (patch.model && !MODELS.some((m) => m.id === patch.model) && !/^[a-z0-9][a-z0-9.:-]{2,}$/i.test(patch.model)) {
    return NextResponse.json({ error: "model: not a model id" }, { status: 400 });
  }
  try {
    return NextResponse.json(redact(saveSettings(patch)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
