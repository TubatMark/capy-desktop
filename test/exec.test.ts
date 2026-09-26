import { describe, expect, it } from "vitest";
import { CancelledError, currentSignal, run, throwIfCancelled, withCancel } from "../src/exec";

describe("withCancel", () => {
  it("kills a running child when the scope is aborted", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = withCancel(ac.signal, () => run("sleep", ["10"]));
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("refuses to spawn inside an already-cancelled scope", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(withCancel(ac.signal, () => run("true", []))).rejects.toBeInstanceOf(CancelledError);
  });

  it("propagates the signal through nested awaits and reports it via throwIfCancelled", async () => {
    const ac = new AbortController();
    await withCancel(ac.signal, async () => {
      await Promise.resolve();
      expect(currentSignal()).toBe(ac.signal);
      expect(() => throwIfCancelled()).not.toThrow();
      ac.abort();
      expect(() => throwIfCancelled()).toThrow(CancelledError);
    });
    expect(currentSignal()).toBeUndefined();
  });

  it("runs normally when there is no scope", async () => {
    const { stdout } = await run("echo", ["ok"]);
    expect(stdout.trim()).toBe("ok");
  });
});
