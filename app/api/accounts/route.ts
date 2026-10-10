import { NextResponse } from "next/server";
import { publicAccounts, publicReadingAccount } from "@/server/accounts";

export const dynamic = "force-dynamic";

/** GET = every platform's account state (no tokens, secret redacted). */
export async function GET(req: Request) {
  return NextResponse.json(
    new URL(req.url).searchParams.get("role") === "reading"
      ? publicReadingAccount()
      : publicAccounts(),
  );
}
