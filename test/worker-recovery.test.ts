import { describe, it, expect } from "vitest";
import { fork, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/db";
import { WorkQueue } from "../server/worker/leases";
import {
  run,
  withCancel,
  DeadlineError,
  terminateProcessGroup,
} from "../src/exec";
const request = (p: ReturnType<typeof fork>, m: any) =>
  new Promise<any>((resolve, reject) => {
    p.once("message", resolve);
    p.once("error", reject);
    p.send(m);
  });
describe("worker process recovery", () => {
  it("one_owner_after_lease_expiry", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "capy-process-"));
    const db = path.join(dir, "state.sqlite");
    const store = new Store(db);
    const q = new WorkQueue(store);
    await q.enqueue({
      kind: "fixture",
      workKey: "one",
      inputRevision: 1,
      payload: {},
    });
    const child = () =>
      fork(path.resolve("test/fixtures/worker-process.ts"), [], {
        execArgv: ["--experimental-sqlite", "--import", "tsx"],
        env: { ...process.env, TEST_DB: db },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
    const a = child(),
      b = child();
    try {
      await Promise.all([
        new Promise((r) => a.once("message", r)),
        new Promise((r) => b.once("message", r)),
      ]);
      const claims = await Promise.all([
        request(a, { action: "claim", owner: "a", now: 100 }),
        request(b, { action: "claim", owner: "b", now: 100 }),
      ]);
      expect(claims.filter((x) => x.lease)).toHaveLength(1);
      const first = claims.find((x) => x.lease)!.lease;
      const next = (
        await request(b, { action: "claim", owner: "replacement", now: 401 })
      ).lease;
      expect(next.generation).toBe(first.generation + 1);
      expect(
        await request(a, { action: "checkpoint", lease: first, now: 402 }),
      ).toEqual({ error: "LeaseLostError" });
    } finally {
      a.kill();
      b.kill();
      store.close();
    }
  });
  it.each([
    "before-meta",
    "after-transcript",
    "during-download",
    "during-render",
  ])(
    "real process restart preserves artifacts at %s",
    async (fault) => {
      const dir = mkdtempSync(path.join(tmpdir(), "capy-restart-"));
      const db = path.join(dir, "state.sqlite");
      const out = path.join(dir, "out");
      const store = new Store(db);
      const q = new WorkQueue(store, { leaseMs: 300 });
      const task = await q.enqueue({
        kind: "fixture",
        workKey: "restart",
        inputRevision: 1,
        payload: {},
      });
      const child = (point: string) =>
        fork(path.resolve("test/fixtures/worker-recovery-process.ts"), [], {
          execArgv: ["--experimental-sqlite", "--import", "tsx"],
          env: {
            ...process.env,
            CAPY_DATA_DIR: dir,
            TEST_DB: db,
            TEST_OUT: out,
            FAULT_POINT: point,
            OWNER: point ? "first" : "replacement",
          },
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
      const a = child(fault);
      let b: ReturnType<typeof fork> | undefined;
      try {
        await new Promise((resolve) => a.once("message", resolve));
        const previous = q.get(task.id)!;
        const complete = previous.checkpoint.complete as string[] | undefined;
        const original =
          complete?.map((name) => readFileSync(path.join(out, name), "utf8")) ??
          [];
        const stopped = new Promise((resolve) => a.once("exit", resolve));
        a.kill("SIGKILL");
        await stopped;
        await new Promise((resolve) => setTimeout(resolve, 350));
        b = child("");
        const result = await new Promise<any>((resolve) =>
          b!.once("message", resolve),
        );
        expect(result.complete.status).toBe("complete");
        expect(result.complete.checkpoint.complete).toEqual([
          "meta",
          "transcript",
          "download",
          "render",
        ]);
        expect(
          complete?.map((name) => readFileSync(path.join(out, name), "utf8")) ??
            [],
        ).toEqual(original);
        for (const group of previous.groups)
          expect(() => process.kill(group.pid, 0)).toThrow();
      } finally {
        a.kill();
        b?.kill();
        store.close();
      }
    },
    10000,
  );
  it("deadline kills subprocess subtree before settling", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "capy-tree-"));
    const pid = path.join(dir, "pid");
    const promise = run(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('child_process');const fs=require('fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pid)},String(p.pid));setInterval(()=>{},1000);`,
      ],
      { timeoutMs: 400, killGraceMs: 30 },
    );
    await expect(promise).rejects.toBeInstanceOf(DeadlineError);
    const descendant = Number(readFileSync(pid, "utf8"));
    expect(() => process.kill(descendant, 0)).toThrow();
  });
  it("stale process identity cannot signal an unrelated reused group", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await terminateProcessGroup(
        child.pid!,
        20,
        "wrong-generation-token",
        "older-start-time",
      );
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
    }
  });
  it("cancellation kills subprocess subtree before replacement", async () => {
    const ac = new AbortController();
    const p = withCancel(ac.signal, () =>
      run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        killGraceMs: 30,
      }),
    );
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow("Cancelled");
  });
});
