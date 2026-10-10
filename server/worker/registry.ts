import type { JobLease } from "./leases";
import type { WorkStage } from "./runner";
const factories = new Map<string, (lease: JobLease) => WorkStage[]>();
export function registerWork(
  kind: string,
  factory: (lease: JobLease) => WorkStage[],
) {
  factories.set(kind, factory);
}
export function stagesFor(lease: JobLease) {
  const fn = factories.get(lease.kind);
  if (!fn)
    throw Object.assign(Error(`Unsupported work kind: ${lease.kind}`), {
      retryable: false,
    });
  return fn(lease);
}
