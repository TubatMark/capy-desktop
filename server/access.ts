import type { Access } from "../lib/types";

/**
 * Who is using the app and what they may do. Today there is no sign-in: everyone is the
 * local owner with every capability. When accounts and plans arrive, this is the one
 * server module to replace (read a session cookie, look up the plan, fill `can`); the
 * routes and `<AccessGate>` already consume it.
 */
export async function getAccess(_req?: Request): Promise<Access> {
  return { user: { id: "local", name: "Local owner" }, plan: "local", can: { createJob: true, render: true } };
}

/** 403 body used by every gated route, so the UI can recognise it. */
export const FORBIDDEN = { error: "Sign in required", code: "forbidden" } as const;
