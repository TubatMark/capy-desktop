import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const ai = vi.hoisted(() => ({ assert: vi.fn() }));
vi.mock("../server/ai-usage", () => ({ assertAiBudgetAvailable: ai.assert }));
import { admitResources } from "../server/worker/budget";
import { Store } from "../server/db";
import { WorkQueue } from "../server/worker/leases";

describe("worker resource admission", () => {
  it("preserves artifacts and admits deterministic work with exhausted AI allowance", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "capy-worker-budget-"));
    const store = new Store(path.join(root, "state.sqlite"));
    const queue = new WorkQueue(store);
    await queue.enqueue({
      kind: "fixture",
      workKey: "one",
      inputRevision: 1,
      payload: {},
    });
    const lease = (await queue.claim("fixture"))!;
    const artifact = path.join(root, "completed.mp4");
    writeFileSync(artifact, "completed-source");
    const previous = process.env.CAPY_DISK_RESERVE_BYTES;
    try {
      process.env.CAPY_DISK_RESERVE_BYTES = "0";
      ai.assert.mockImplementation(() => {
        throw Error("AI budget exhausted");
      });
      const deterministic = {
        name: "proxy",
        expensive: true,
        run: async () => {},
      };
      expect(admitResources(lease, root, deterministic)).toEqual([]);
      expect(ai.assert).not.toHaveBeenCalled();
      expect(
        admitResources(lease, root, { ...deterministic, ai: true }),
      ).toEqual(["AI budget exhausted"]);
      process.env.CAPY_DISK_RESERVE_BYTES = String(Number.MAX_SAFE_INTEGER);
      expect(admitResources(lease, root, deterministic)).toEqual([
        "Disk reserve would be exceeded",
      ]);
      expect(readFileSync(artifact, "utf8")).toBe("completed-source");
    } finally {
      if (previous === undefined) delete process.env.CAPY_DISK_RESERVE_BYTES;
      else process.env.CAPY_DISK_RESERVE_BYTES = previous;
      store.close();
    }
  });
});
