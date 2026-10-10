import { AsyncLocalStorage } from "node:async_hooks";
import type { JobLease, WorkQueue } from "./leases";
export interface WorkerContext {
  queue: WorkQueue;
  lease: JobLease;
  workspace: string;
  signal: AbortSignal;
  jobRevisions?: Map<string, number>;
}
const context = new AsyncLocalStorage<WorkerContext>();
export const currentWork = () => context.getStore();
export const withWork = <T>(ctx: WorkerContext, fn: () => Promise<T>) =>
  context.run(ctx, fn);
export function fence<T>(fn: () => T): T {
  const ctx = currentWork();
  return ctx ? ctx.queue.fenced(ctx.lease, fn) : fn();
}
export function assertWork() {
  const ctx = currentWork();
  if (ctx) ctx.queue.assert(ctx.lease);
}
