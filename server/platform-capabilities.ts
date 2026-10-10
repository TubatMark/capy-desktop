import type { Platform } from "../lib/types";
import type { StoredAccount } from "./accounts";
import { runtimeStore } from "./db/runtime";
import { createHash } from "node:crypto";
export interface DestinationCapabilities {
  accountId: string;
  platform: Platform;
  connected: boolean;
  checkedAt: number;
  resumable: "documented" | "status-only";
  scheduling: "verified" | "unverified" | "unsupported";
  customThumbnail: "accepted-before" | "unverified" | "unsupported";
  directPublishing: "manual" | "assisted-only";
  automaticPublication: false;
  reason: string;
  docsCheckedAt: "2026-10-10";
}
export function destinationClientIdentity(
  platform: Platform,
  a: StoredAccount,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        platform,
        a.clientId,
        a.clientSecret,
        platform === "instagram" ? a.igUserId : a.account?.id,
      ]),
    )
    .digest("hex");
}
export function capabilitiesForAccount(
  platform: Platform,
  a: StoredAccount,
): DestinationCapabilities {
  const accountId =
      (platform === "instagram" ? a.igUserId : a.account?.id) ?? "",
    connected = !!a.tokens?.accessToken && !a.needsReconnect;
  const evidence = runtimeStore().get<{
    accountId: string;
    clientIdentity: string;
    checkedAt: number;
    schedulingVerified?: boolean;
    thumbnailAccepted?: boolean;
  }>("destination-capabilities", `${platform}:${accountId}`)?.value;
  const verified =
    evidence &&
    evidence.accountId === accountId &&
    evidence.clientIdentity === destinationClientIdentity(platform, a) &&
    Number.isFinite(evidence.checkedAt) &&
    Date.now() - evidence.checkedAt < 30 * 86400000 &&
    evidence.checkedAt <= Date.now();
  return {
    accountId,
    platform,
    connected,
    checkedAt: Date.now(),
    resumable: platform === "instagram" ? "status-only" : "documented",
    scheduling:
      platform !== "youtube"
        ? "unsupported"
        : connected && verified && evidence.schedulingVerified
          ? "verified"
          : "unverified",
    customThumbnail:
      platform !== "youtube"
        ? "unsupported"
        : connected && verified && evidence.thumbnailAccepted
          ? "accepted-before"
          : "unverified",
    directPublishing: platform === "tiktok" ? "assisted-only" : "manual",
    automaticPublication: false,
    reason:
      "Automatic publication remains disabled pending a real 72-hour fault soak and separately authorized controlled upload",
    docsCheckedAt: "2026-10-10",
  };
}
/** Local evidence only: this accessor never probes a destination by uploading. */
export async function getDestinationCapabilities(
  accountId: string,
): Promise<DestinationCapabilities> {
  const { loadAccounts } = await import("./accounts");
  const all = loadAccounts();
  const matches = (["youtube", "instagram", "tiktok"] as const).filter(
    (p) =>
      (p === "instagram" ? all[p].igUserId : all[p].account?.id) === accountId,
  );
  if (!accountId || matches.length !== 1)
    throw Error("Select one exact publishing account");
  return capabilitiesForAccount(matches[0]!, all[matches[0]!]);
}
/** Daily quotas reset on the Pacific calendar, including DST transitions. */
export function nextQuotaReset(now: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(now);
  let low = now,
    high = now + 26 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (fmt.format(mid) === today) low = mid;
    else high = mid;
  }
  return Math.ceil(high / 1000) * 1000;
}
