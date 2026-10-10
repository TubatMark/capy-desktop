import { Store } from "../../server/db";
import { WorkQueue } from "../../server/worker/leases";
const q = new WorkQueue(new Store(process.env.TEST_DB!), { leaseMs: 300 });
process.on("message", async (m: any) => {
  try {
    if (m.action === "claim")
      process.send?.({ lease: await q.claim(m.owner, m.now) });
    if (m.action === "checkpoint") {
      q.checkpoint(m.lease, "stage", {}, m.now);
      process.send?.({ ok: true });
    }
  } catch (e) {
    process.send?.({ error: (e as Error).name });
  }
});
process.send?.({ ready: true });
