import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db";
import { startWorkerService } from "../electron/worker-service";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await pause(100);
  }
  throw Error("Worker smoke condition did not become true");
}
it("bundled second supervisor waits, survives election loss and takes over after first stops", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "capy-worker-bundle-"));
  const prior = process.env.CAPY_OUTPUT;
  process.env.CAPY_OUTPUT = path.join(dir, "out");
  const store = new Store(path.join(dir, "capy.sqlite"));
  const options = {
    dev: true,
    dataDir: dir,
    workerFile: path.resolve("dist-electron/worker.cjs"),
    executable: process.execPath,
    restartMs: 30,
  };
  const a = startWorkerService(options);
  let b: ReturnType<typeof startWorkerService> | undefined;
  try {
    await until(() => !!store.get("worker", "service"));
    const first = store.get<{ owner: string }>("worker", "service")!.value
      .owner;
    b = startWorkerService(options);
    let secondPid = b.pid();
    await pause(6000);
    expect(store.get<{ owner: string }>("worker", "service")!.value.owner).toBe(
      first,
    );
    expect(b.pid()).toBe(secondPid);
    expect(() => process.kill(secondPid!, 0)).not.toThrow();
    // Killing only this supervised standby child must restart it without disturbing the owner.
    process.kill(secondPid!, "SIGKILL");
    await until(() => b!.pid() !== secondPid);
    secondPid = b.pid();
    expect(() => process.kill(secondPid!, 0)).not.toThrow();
    expect(store.get<{ owner: string }>("worker", "service")!.value.owner).toBe(
      first,
    );
    await a.stop();
    await until(
      () =>
        store.get<{ owner: string }>("worker", "service")!.value.owner !==
        first,
    );
    expect(b.pid()).toBe(secondPid);
    // A changed service owner cancels active scope but keeps the process standing by.
    store.put("worker", "service", {
      owner: "fixture-external-owner",
      heartbeat: Date.now(),
      expiresAt: Date.now() + 8000,
    });
    await pause(5500);
    expect(b.pid()).toBe(secondPid);
    expect(() => process.kill(secondPid!, 0)).not.toThrow();
  } finally {
    await a.stop();
    await b?.stop();
    store.close();
    if (prior === undefined) delete process.env.CAPY_OUTPUT;
    else process.env.CAPY_OUTPUT = prior;
  }
}, 20000);
