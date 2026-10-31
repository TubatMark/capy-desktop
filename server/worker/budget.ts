import { execFileSync } from "node:child_process";
import { statfsSync, mkdirSync } from "node:fs";
import { assertAiBudgetAvailable } from "../ai-usage";
import type { JobLease } from "./leases";
import type { WorkStage } from "./runner";
/** Long videos wait below this share of free memory, so editing never squeezes the rest of the Mac. */
export const LONG_FORM_MIN_FREE_MEMORY = 20;

/** macOS's own measure, which counts memory it can reclaim. Undefined where the tool doesn't exist. */
export function freeMemoryPercent(read = () => execFileSync("memory_pressure", [], { encoding: "utf8", timeout: 10_000 })): number | undefined {
  try {
    const m = read().match(/free percentage:\s*(\d+)%/);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

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
  if (lease.kind === "longform" || lease.kind === "longform-upload") {
    const free = freeMemoryPercent();
    if (free !== undefined && free < LONG_FORM_MIN_FREE_MEMORY) reasons.push(`Waiting for memory: ${free}% free`);
  }
  if (stage?.ai)
    try {
      assertAiBudgetAvailable(String(lease.payload.jobId ?? lease.id));
    } catch (e) {
      reasons.push((e as Error).message);
    }
  return reasons;
}
