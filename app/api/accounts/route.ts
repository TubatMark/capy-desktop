import { NextResponse } from "next/server";
import { publicAccounts } from "@/server/accounts";

export const dynamic = "force-dynamic";

/** GET = every platform's account state (no tokens, secret redacted). */
export async function GET() {
  return NextResponse.json(publicAccounts());
}
