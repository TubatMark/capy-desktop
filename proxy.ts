import { NextResponse, type NextRequest } from "next/server";
import { isLocalRequest } from "./server/local-guard";

/** Refuse API calls that don't come from this computer (see server/local-guard.ts). */
export function proxy(req: NextRequest) {
  const ok = isLocalRequest({ host: req.headers.get("host"), origin: req.headers.get("origin"), method: req.method, allowed: process.env.CAPY_ALLOWED_HOSTS });
  if (!ok) return NextResponse.json({ error: "capy only answers requests from this computer" }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
