import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { Store } from "../db";
import { terminateProcessGroup, processIdentity } from "../../src/exec";
export interface WorkInput {
  kind: string;
  workKey: string;
  inputRevision: number;
  payload: Record<string, unknown>;
}
export type { JobRecord } from "../../lib/studio/types";
import type { JobRecord } from "../../lib/studio/types";
export interface JobLease extends JobRecord {
  owner: string;
}
export class LeaseLostError extends Error {
  constructor() {
    super("Worker lease expired or replaced");
    this.name = "LeaseLostError";
  }
}
export class WorkQueue {
  readonly leaseMs: number;
  readonly queueCapacity: number;
  constructor(
    readonly store: Store,
    opts: { leaseMs?: number; queueCapacity?: number } = {},
  ) {
    this.leaseMs = opts.leaseMs ?? 15_000;
    this.queueCapacity = opts.queueCapacity ?? 100;
  }
  get(id: string) {
    return this.store.get<JobRecord>("work", id)?.value;
  }
  list() {
    return this.store.list<JobRecord>("work").map((x) => x.value);
  }
  async enqueue(input: WorkInput): Promise<JobRecord> {
    if (
      !input.kind ||
      !input.workKey ||
      !Number.isSafeInteger(input.inputRevision) ||
      input.inputRevision < 0
    )
      throw Error("Invalid work input");
    return this.store.transaction(() => {
      const existing = this.list().find(
        (x) =>
          x.workKey === input.workKey &&
          x.inputRevision === input.inputRevision,
      );
      if (existing) return existing;
      if (
        this.list().filter(
          (x) => !["complete", "cancelled", "needs_action"].includes(x.status),
        ).length >= this.queueCapacity
      )
        throw Error("Worker queue capacity reached");
      const record: JobRecord = {
        ...input,
        id: randomUUID(),
        stage: "queued",
        status: "queued",
        checkpoint: {},
        generation: 0,
        expiresAt: 0,
        attempts: 0,
        cancelRequested: false,
        createdAt: Date.now(),
        groups: [],
      };
      this.store.put("work", record.id, record);
      return record;
    });
  }
  async claim(owner: string, now = Date.now()): Promise<JobLease | null> {
    // Stop every registered process group of expired work before making it eligible for a replacement.
    for (const job of this.list().filter(
      (x) => x.status === "running" && x.expiresAt <= now,
    )) {
      for (const group of job.groups)
        await terminateProcessGroup(
          group.pid,
          150,
          group.token,
          group.identity,
        );
      if (job.cancelRequested)
        this.store.transaction(() => {
          const cur = this.get(job.id);
          if (cur?.generation === job.generation && cur.expiresAt <= now)
            this.store.put("work", job.id, {
              ...cur,
              status: "cancelled",
              groups: [],
              expiresAt: 0,
            });
        });
    }
    return this.store.transaction(() => {
      const job = this.list()
        .filter(
          (x) =>
            !x.cancelRequested &&
            ((["queued", "retryable", "blocked"].includes(x.status) &&
              (x.retryAt ?? 0) <= now) ||
              (x.status === "running" && x.expiresAt <= now)),
        )
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!job) return null;
      const lease: JobLease = {
        ...job,
        owner,
        generation: job.generation + 1,
        expiresAt: now + this.leaseMs,
        status: "running",
        attempts: job.attempts + 1,
        groups: [],
        error: undefined,
      };
      this.store.put("work", job.id, lease);
      return lease;
    });
  }
  assert(lease: JobLease, now = Date.now()) {
    const service = this.store.get<{ owner: string; expiresAt: number }>(
      "worker",
      "service",
    )?.value;
    const current = this.get(lease.id);
    if (
      (service &&
        (service.owner !== lease.owner || service.expiresAt <= now)) ||
      !current ||
      current.owner !== lease.owner ||
      current.generation !== lease.generation ||
      current.expiresAt <= now ||
      current.status !== "running" ||
      current.cancelRequested
    )
      throw new LeaseLostError();
    return current;
  }
  fenced<T>(lease: JobLease, fn: () => T, now = Date.now()): T {
    return this.store.transaction(() => {
      this.assert(lease, now);
      return fn();
    });
  }
  checkpoint(
    lease: JobLease,
    stage: string,
    data: Record<string, unknown>,
    now = Date.now(),
  ) {
    return this.fenced(
      lease,
      () => {
        const current = this.get(lease.id)!;
        this.store.put("work", lease.id, {
          ...current,
          stage,
          checkpoint: { ...current.checkpoint, ...data },
        });
      },
      now,
    );
  }
  heartbeat(lease: JobLease, now = Date.now()) {
    return this.fenced(
      lease,
      () => {
        this.store.put("work", lease.id, {
          ...this.get(lease.id)!,
          expiresAt: now + this.leaseMs,
        });
      },
      now,
    );
  }
  group(lease: JobLease, pid: number, active: boolean, token = "") {
    this.fenced(lease, () => {
      const cur = this.get(lease.id)!;
      this.store.put("work", lease.id, {
        ...cur,
        groups: active
          ? [
              ...cur.groups.filter((x) => x.pid !== pid),
              { pid, token, identity: processIdentity(pid) },
            ]
          : cur.groups.filter((x) => x.pid !== pid),
      });
    });
  }
  promote(
    lease: JobLease,
    files: { from: string; to: string }[],
    now = Date.now(),
  ) {
    this.fenced(
      lease,
      () => {
        for (const file of files) {
          mkdirSync(path.dirname(file.to), { recursive: true });
          renameSync(file.from, file.to);
        }
      },
      now,
    );
  }
  finish(
    lease: JobLease,
    status: JobRecord["status"],
    error?: string,
    retryAt?: number,
  ) {
    this.fenced(lease, () =>
      this.store.put("work", lease.id, {
        ...this.get(lease.id)!,
        status,
        error,
        retryAt,
        expiresAt: 0,
        groups: [],
      }),
    );
  }
  async cancel(id: string) {
    this.store.transaction(() => {
      const job = this.get(id);
      if (!job) return;
      this.store.put("work", id, {
        ...job,
        cancelRequested: true,
        status: job.status === "running" ? "running" : "cancelled",
      });
    });
  }
  acknowledgeCancel(lease: JobLease) {
    this.store.transaction(() => {
      const job = this.get(lease.id);
      if (job?.owner === lease.owner && job.generation === lease.generation)
        this.store.put("work", lease.id, {
          ...job,
          status: "cancelled",
          expiresAt: 0,
          groups: [],
        });
    });
  }
}
