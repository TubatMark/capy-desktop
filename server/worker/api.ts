import { runtimeStore } from "../db/runtime";
import { WorkQueue, type WorkInput, type JobRecord } from "./leases";
export type { WorkInput, JobRecord, JobLease } from "./leases";
export const workQueue = () =>
  new WorkQueue(runtimeStore(), {
    queueCapacity: Number(process.env.CAPY_QUEUE_CAPACITY ?? 100),
  });
export const enqueueWork = (input: WorkInput): Promise<JobRecord> =>
  workQueue().enqueue(input);
export const claimWork = (workerId: string, now = Date.now()) =>
  workQueue().claim(workerId, now);
export const cancelJob = (id: string) => workQueue().cancel(id);
export interface WorkerHealth {
  heartbeat: number;
  owner?: string;
  activeStages: { id: string; stage: string }[];
  resourceLimits: { queueCapacity: number; diskReserveBytes: number };
  blockedReasons: string[];
}
export async function getWorkerHealth(): Promise<WorkerHealth> {
  const q = workQueue();
  const service = runtimeStore().get<{ owner: string; heartbeat: number }>(
    "worker",
    "service",
  )?.value;
  return {
    heartbeat: service?.heartbeat ?? 0,
    owner: service?.owner,
    activeStages: q
      .list()
      .filter((x) => x.status === "running")
      .map((x) => ({ id: x.id, stage: x.stage })),
    resourceLimits: {
      queueCapacity: q.queueCapacity,
      diskReserveBytes: Number(
        process.env.CAPY_DISK_RESERVE_BYTES ?? 1024 ** 3,
      ),
    },
    blockedReasons: q
      .list()
      .filter((x) => x.status === "blocked")
      .map((x) => x.error ?? "blocked"),
  };
}
