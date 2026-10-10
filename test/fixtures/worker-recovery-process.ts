import { Store } from "../../server/db";
import { WorkQueue } from "../../server/worker/leases";
import { runJob, type StageContext } from "../../server/worker/runner";
import { run } from "../../src/exec";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Startup/module loading happens before claiming a production-length lease.
const store = new Store(process.env.TEST_DB!);
const q = new WorkQueue(store);
const root = process.env.TEST_OUT!;
const fault = process.env.FAULT_POINT;
function command(action: string): Promise<void> {
  return new Promise((resolve) => {
    const receive = (message: unknown) => {
      if ((message as { action?: string })?.action !== action) return;
      process.off("message", receive);
      resolve();
    };
    process.on("message", receive);
  });
}
const stages = ["meta", "transcript", "download", "render"].map((name) => ({
  name,
  run: async (ctx: StageContext) => {
    if (
      (fault === "before-meta" && name === "meta") ||
      (fault === "after-transcript" && name === "download")
    ) {
      process.send?.({ type: "fault", fault });
      await new Promise(() => {});
    }
    // A scheduling gap longer than the old 300ms fixture lease must not cause a false restart failure.
    if (!fault && name === "download") {
      const until = Date.now() + Number(ctx.lease.payload.boundaryPauseMs ?? 0);
      while (Date.now() < until) {
        /* Deliberately withhold the fixture heartbeat. */
      }
    }
    mkdirSync(ctx.workspace, { recursive: true });
    const file = path.join(ctx.workspace, name);
    if (
      (fault === "during-download" && name === "download") ||
      (fault === "during-render" && name === "render")
    )
      await run(
        process.execPath,
        [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(file + ".part")},'partial');process.stderr.write('ready');setInterval(()=>{},1000);`,
        ],
        {
          onStderr: (chunk) => {
            if (chunk.includes("ready"))
              process.send?.({ type: "fault", fault });
          },
        },
      );
    await run(process.execPath, [
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(file)},${JSON.stringify(name)});`,
    ]);
    return { artifacts: [{ from: file, to: path.join(root, name) }] };
  },
}));
try {
  const start = command("start");
  process.send?.({ type: "ready" });
  await start;
  const lease = await q.claim(process.env.OWNER ?? "fixture");
  if (!lease) throw Error("No fixture work");
  const proceed = command("run");
  process.send?.({ type: "claimed", lease });
  await proceed;
  let failure: string | undefined;
  await runJob(lease, new AbortController().signal, {
    queue: q,
    stages,
    artifactRoot: root,
    onError: (error) => {
      failure = (error as Error).name;
    },
  });
  process.send?.({ type: "complete", complete: q.get(lease.id), failure });
} catch (error) {
  process.send?.({ type: "error", message: (error as Error).message });
  process.exitCode = 1;
} finally {
  store.close();
  process.disconnect?.();
}
