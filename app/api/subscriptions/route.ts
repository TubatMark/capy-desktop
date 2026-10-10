import { NextResponse } from "next/server";
import {
  importCreators,
  listSubscriptions,
  SubscriptionAccessError,
} from "@/server/subscriptions";
import type { CreatorImport } from "@/lib/types";
export const dynamic = "force-dynamic";
function failure(error: unknown) {
  return NextResponse.json(
    {
      error: error instanceof Error ? error.message : String(error),
      reconnect: error instanceof SubscriptionAccessError,
    },
    { status: error instanceof SubscriptionAccessError ? 401 : 400 },
  );
}
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const accountId = params.get("accountId");
  if (!accountId)
    return NextResponse.json(
      { error: "Choose a reading account" },
      { status: 400 },
    );
  try {
    return NextResponse.json(
      await listSubscriptions(accountId, params.get("cursor") ?? undefined),
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(req: Request) {
  try {
    return NextResponse.json(
      await importCreators((await req.json()) as CreatorImport),
    );
  } catch (error) {
    return failure(error);
  }
}
