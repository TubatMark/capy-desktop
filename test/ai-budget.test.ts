import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db";
import { reserveAiBudget, settleAiBudget } from "../server/ai-usage";
const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);
function open() {
  const d = mkdtempSync(path.join(tmpdir(), "capy-ai-"));
  dirs.push(d);
  return new Store(path.join(d, "db.sqlite"));
}
const request = {
  key: "one",
  jobId: "job",
  task: "metadata" as const,
  ceilingUsd: 0.6,
  requests: 2,
  tokens: 100,
  maxJobUsd: 1,
  maxDayUsd: 1,
  maxDayRequests: 10,
  maxDayTokens: 1000,
};
describe("AI budgets", () => {
  it("concurrent workers cannot overspend reserved ceiling", async () => {
    const a = open();
    const b = new Store(a.file);
    try {
      const outcomes = await Promise.allSettled([
        reserveAiBudget(request, a),
        reserveAiBudget({ ...request, key: "two", jobId: "other" }, b),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    } finally {
      a.close();
      b.close();
    }
  });
  it("unknown price is retained and estimated cost is reconciled once", async () => {
    const s = open();
    try {
      const r = await reserveAiBudget(request, s);
      await settleAiBudget(r.id, { basis: "unknown" }, 1, 20, s);
      await expect(
        reserveAiBudget({ ...request, key: "two" }, s),
      ).rejects.toThrow(/budget/i);
      await settleAiBudget(r.id, { basis: "estimated", value: 0 }, 0, 0, s);
      expect(s.get<any>("ai-budget-day", r.day)?.value.usd).toBe(0.6);
    } finally {
      s.close();
    }
  });
  it("says which limit ran out", async () => {
    const s = open();
    try {
      await reserveAiBudget({ ...request, maxDayUsd: 5 }, s);
      await expect(
        reserveAiBudget({ ...request, key: "two", maxDayUsd: 5 }, s),
      ).rejects.toThrow(/this video reached its \$1\.00 AI limit/);
      await expect(
        reserveAiBudget({ ...request, key: "three", jobId: "other" }, s),
      ).rejects.toThrow(/today's \$1\.00 AI limit is used up/);
    } finally {
      s.close();
    }
  });
  it("idempotency cannot reuse a completed reservation", async () => {
    const s = open();
    try {
      const r = await reserveAiBudget(request, s);
      await settleAiBudget(r.id, { basis: "estimated", value: 0.1 }, 1, 20, s);
      await expect(reserveAiBudget(request, s)).rejects.toThrow(/already/i);
    } finally {
      s.close();
    }
  });
});

import { recoverAiReservations } from "../server/ai-usage";
it("orphan recovery retains unknown spend after worker death", async () => {
  const s = open();
  try {
    await reserveAiBudget(request, s);
    expect(recoverAiReservations(Date.now() + 1, s)).toBe(1);
    expect(recoverAiReservations(Date.now() + 1, s)).toBe(0);
    await expect(
      reserveAiBudget({ ...request, key: "after-death" }, s),
    ).rejects.toThrow(/budget/i);
    expect(s.get<any>("ai-reservation", request.key)?.value.state).toBe(
      "orphaned",
    );
  } finally {
    s.close();
  }
});

import { fork, type ChildProcess } from "node:child_process";
it("two separate worker processes race the same daily budget transaction", async () => {
  const store = open();
  const child = () =>
    fork(path.resolve("test/fixtures/ai-budget-process.ts"), [], {
      execArgv: ["--experimental-sqlite", "--import", "tsx"],
      env: { ...process.env, TEST_DB: store.file },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
  const a = child();
  const b = child();
  const receive = (process: ChildProcess) =>
    new Promise<any>((resolve, reject) => {
      process.once("message", resolve);
      process.once("error", reject);
    });
  try {
    await Promise.all([receive(a), receive(b)]);
    const outcomes = [receive(a), receive(b)];
    a.send({ key: "worker-a" });
    b.send({ key: "worker-b" });
    const results = await Promise.all(outcomes);
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    expect(
      results.filter((r) => r.error?.includes("budget exhausted")),
    ).toHaveLength(1);
    expect(store.list("ai-reservation")).toHaveLength(1);
  } finally {
    a.kill();
    b.kill();
    store.close();
  }
});
