"use client";
import { useEffect, useState } from "react";
import type { Access } from "@/lib/types";

/** Until sign-in exists, everyone is the local owner (mirrors server/access.ts). */
export const LOCAL_ACCESS: Access = { user: { id: "local", name: "Local owner" }, plan: "local", can: { createJob: true, render: true } };

let cached: Access | null = null;

/** Current user + capabilities from GET /api/me. Returns the local owner until the request resolves. */
export function useAccess(): Access {
  const [access, setAccess] = useState<Access>(cached ?? LOCAL_ACCESS);
  useEffect(() => {
    if (cached) return;
    fetch("/api/me")
      .then((r) => (r.ok ? (r.json() as Promise<Access>) : LOCAL_ACCESS))
      .then((a) => {
        cached = a;
        setAccess(a);
      })
      .catch(() => {});
  }, []);
  return access;
}
