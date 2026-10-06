import { NextResponse } from "next/server";

/** A route handler's error answer: the error's own status (404, 409…) or 400. */
export function errorResponse(e: unknown) {
  const status = (e as { status?: number }).status ?? 400;
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
}
