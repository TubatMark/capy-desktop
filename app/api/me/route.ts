import { NextResponse } from "next/server";
import { getAccess } from "@/server/access";

export const dynamic = "force-dynamic";

/** The current user and what they may do (see server/access.ts). */
export async function GET(req: Request) {
  return NextResponse.json(await getAccess(req));
}
