import { Store } from "../../server/db";
import { WorkQueue } from "../../server/worker/leases";
import { runJob } from "../../server/worker/runner";
import { run } from "../../src/exec";
import { mkdirSync } from "node:fs";
import path from "node:path";
const store = new Store(process.env.TEST_DB!);
const q = new WorkQueue(store, { leaseMs: 300 });
const root = process.env.TEST_OUT!;
const stages = ["meta", "transcript", "download", "render"].map((name) => ({
  name,
  run: async (ctx: any) => {
    const fault = process.env.FAULT_POINT;
    if (
      (fault === "before-meta" && name === "meta") ||
      (fault === "after-transcript" && name === "download")
    ) {
      process.send?.({ fault });
      await new Promise(() => {});
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
            if (chunk.includes("ready")) process.send?.({ fault });
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
const lease = await q.claim(process.env.OWNER ?? "fixture");
if (!lease) throw Error("No fixture work");
await runJob(lease, new AbortController().signal, {
  queue: q,
  stages,
  artifactRoot: root,
});
process.send?.({ complete: q.get(lease.id) });
store.close();
process.disconnect?.();
