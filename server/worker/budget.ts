import { statfsSync, mkdirSync } from "node:fs";
import { assertAiBudgetAvailable } from "../ai-usage";
import type { JobLease } from "./leases";
import type { WorkStage } from "./runner";
export function admitResources(
  lease: JobLease,
  root: string,
  stage?: WorkStage,
): string[] {
  const reasons: string[] = [];
  mkdirSync(root, { recursive: true });
  const fs = statfsSync(root);
  const reserve = Number(process.env.CAPY_DISK_RESERVE_BYTES ?? 1024 ** 3);
  if (fs.bavail * fs.bsize < reserve)
    reasons.push("Disk reserve would be exceeded");
  if (stage?.ai)
    try {
      assertAiBudgetAvailable(String(lease.payload.jobId ?? lease.id));
    } catch (e) {
      reasons.push((e as Error).message);
    }
  return reasons;
}
