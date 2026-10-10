import { mkdirSync } from "node:fs";
import path from "node:path";
import { isCancelled, withCancel, withExecution } from "../../src/exec";
import { LeaseLostError, type JobLease, type WorkQueue } from "./leases";
import { withWork } from "./context";
import { withAiContext } from "../ai-router";
export interface StageContext {
  workspace: string;
  signal: AbortSignal;
  lease: JobLease;
  assert(): void;
  fenced<T>(fn: () => T): T;
  checkpoint(data: Record<string, unknown>): void;
  data: Record<string, unknown>;
}
export interface WorkStage {
  name: string;
  expensive?: boolean;
  ai?: boolean;
  timeoutMs?: number;
  run(ctx: StageContext): Promise<{
    data?: Record<string, unknown>;
    artifacts?: { from: string; to: string }[];
  } | void>;
}
export interface RunnerOptions {
  queue: WorkQueue;
  stages: WorkStage[];
  artifactRoot: string;
  admit?: (lease: JobLease, stage: WorkStage) => Promise<string[]>;
  onError?: (error: unknown) => void;
}
export async function runJob(
  lease: JobLease,
  signal: AbortSignal,
  opts: RunnerOptions,
): Promise<void> {
  const { queue } = opts;
  const ac = new AbortController();
  const abort = () => ac.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) ac.abort();
  const heartbeat = setInterval(
    () => {
      try {
        queue.heartbeat(lease);
      } catch {
        ac.abort();
      }
    },
    Math.max(20, queue.leaseMs / 3),
  );
  try {
    for (const stage of opts.stages) {
      queue.assert(lease);
      const current = queue.get(lease.id)!;
      const complete = (current.checkpoint.complete ?? []) as string[];
      if (complete.includes(stage.name)) continue;
      if (stage.expensive && opts.admit) {
        const reasons = await opts.admit(lease, stage);
        if (reasons.length) {
          queue.finish(
            lease,
            "blocked",
            reasons.join("; "),
            Date.now() + 30_000,
          );
          return;
        }
      }
      const workspace = path.join(
        opts.artifactRoot,
        ".worker",
        lease.id,
        String(lease.generation),
        stage.name,
      );
      mkdirSync(workspace, { recursive: true });
      queue.checkpoint(lease, stage.name, {});
      const ctx: StageContext = {
        workspace,
        signal: ac.signal,
        lease,
        assert: () => queue.assert(lease),
        fenced: (fn) => queue.fenced(lease, fn),
        checkpoint: (data) => queue.checkpoint(lease, stage.name, data),
        data: queue.get(lease.id)!.checkpoint,
      };
      const result = await withWork(
        { queue, lease, workspace, signal: ac.signal },
        () =>
          withExecution(
            {
              assert: ctx.assert,
              timeoutMs: stage.timeoutMs ?? 30 * 60_000,
              onSpawn: (pid, token) => queue.group(lease, pid, true, token),
              onClose: (pid) => {
                try {
                  queue.group(lease, pid, false);
                } catch {}
              },
            },
            () =>
              withAiContext(
                {
                  jobId: String(
                    lease.payload.jobId ?? lease.payload.assetId ?? lease.id,
                  ),
                  inputVersion: String(lease.inputRevision),
                },
                () => withCancel(ac.signal, () => stage.run(ctx)),
              ),
          ),
      );
      queue.fenced(lease, () => {
        if (result?.artifacts) queue.promote(lease, result.artifacts);
        queue.checkpoint(lease, stage.name, {
          ...result?.data,
          complete: [...complete, stage.name],
        });
      });
    }
    queue.finish(lease, "complete");
  } catch (error) {
    opts.onError?.(error);
    const cur = queue.get(lease.id);
    if (cur?.cancelRequested) {
      queue.acknowledgeCancel(lease);
      return;
    }
    if (error instanceof LeaseLostError || ac.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    const budget = (error as { code?: string })?.code === "AI_BUDGET_EXHAUSTED";
    queue.checkpoint(lease, cur?.stage ?? "error", {
      errorStatus: (error as { status?: number })?.status,
    });
    queue.finish(
      lease,
      budget
        ? "blocked"
        : isCancelled(error)
          ? "cancelled"
          : (error as { retryable?: boolean })?.retryable === false ||
              Number((error as { status?: number })?.status) >= 400 ||
              lease.attempts >= 3
            ? "needs_action"
            : "retryable",
      message,
      Date.now() + (budget ? 60_000 : 5_000),
    );
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", abort);
  }
}
