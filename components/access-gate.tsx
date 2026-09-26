"use client";
import { useAccess } from "@/hooks/use-access";
import type { Access } from "@/lib/types";

/**
 * Renders children when the current user may perform `action`; otherwise a disabled
 * placeholder. This is the single UI seam for sign-in / paywall later.
 */
export function AccessGate({ action, children }: { action: keyof Access["can"]; children: React.ReactNode }) {
  const access = useAccess();
  if (access.can[action]) return <>{children}</>;
  return (
    <span className="inline-flex cursor-not-allowed items-center gap-2 text-sm text-muted-foreground" title="Sign in required">
      <span className="pointer-events-none opacity-50">{children}</span>
      <span>Sign in required</span>
    </span>
  );
}
