import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db";
import { WorkQueue, LeaseLostError } from "../server/worker/leases";
import { runJob } from "../server/worker/runner";
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "capy-worker-"));
  return { dir, store: new Store(path.join(dir, "state.sqlite")) };
};
describe("durable worker", () => {
  it("fences checkpoints and artifact promotion after takeover", async () => {
    const { dir, store } = fixture();
    const q = new WorkQueue(store, { leaseMs: 10 });
    await q.enqueue({
      kind: "fixture",
      workKey: "one",
      inputRevision: 1,
      payload: {},
    });
    const a = (await q.claim("a", 100))!;
    const b = (await q.claim("b", 111))!;
    const staged = path.join(dir, "staged");
    writeFileSync(staged, "old");
    expect(() => q.checkpoint(a, "meta", {}, 111)).toThrow(LeaseLostError);
    expect(() =>
      q.promote(a, [{ from: staged, to: path.join(dir, "original") }], 111),
    ).toThrow(LeaseLostError);
    expect(existsSync(staged)).toBe(true);
    expect(existsSync(path.join(dir, "original"))).toBe(false);
    q.checkpoint(b, "meta", { complete: ["meta"] }, 112);
    store.close();
  });
  it("limits_pause_without_data_loss", async () => {
    const { dir, store } = fixture();
    const q = new WorkQueue(store, { queueCapacity: 1 });
    const job = await q.enqueue({
      kind: "fixture",
      workKey: "one",
      inputRevision: 1,
      payload: {},
    });
    await expect(
      q.enqueue({
        kind: "fixture",
        workKey: "two",
        inputRevision: 1,
        payload: {},
      }),
    ).rejects.toThrow(/capacity/i);
    const lease = (await q.claim("a"))!;
    const asset = path.join(dir, "asset");
    writeFileSync(asset, "keep");
    let called = false;
    await runJob(lease, new AbortController().signal, {
      queue: q,
      stages: [
        {
          name: "render",
          expensive: true,
          run: async () => {
            called = true;
            return {};
          },
        },
      ],
      admit: async () => ["disk reserve"],
      artifactRoot: dir,
    });
    expect(called).toBe(false);
    expect(q.get(job.id)?.status).toBe("blocked");
    expect(readFileSync(asset, "utf8")).toBe("keep");
    await q.cancel(job.id);
    expect(await q.claim("b")).toBeNull();
    store.close();
  });
  it("restart_resumes_first_incomplete_stage", async () => {
    const { dir, store } = fixture();
    const q = new WorkQueue(store);
    const called: string[] = [];
    await q.enqueue({
      kind: "fixture",
      workKey: "one",
      inputRevision: 1,
      payload: {},
    });
    const stages = ["meta", "transcript", "download", "render"].map((name) => ({
      name,
      run: async (ctx: any) => {
        called.push(name);
        mkdirSync(ctx.workspace, { recursive: true });
        writeFileSync(path.join(ctx.workspace, name), name);
        return {
          artifacts: [
            { from: path.join(ctx.workspace, name), to: path.join(dir, name) },
          ],
        };
      },
    }));
    const lease = (await q.claim("a"))!;
    q.checkpoint(lease, "download", { complete: ["meta", "transcript"] });
    await runJob(lease, new AbortController().signal, {
      queue: q,
      stages,
      artifactRoot: dir,
    });
    expect(called).toEqual(["download", "render"]);
    expect(q.get(lease.id)?.status).toBe("complete");
    store.close();
  });
});
