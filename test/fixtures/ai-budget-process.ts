import { Store } from "../../server/db";
import { reserveAiBudget } from "../../server/ai-usage";
const store = new Store(process.env.TEST_DB!);
process.on("message", async (message: { key: string }) => {
  try {
    const reservation = await reserveAiBudget(
      {
        key: message.key,
        jobId: message.key,
        task: "metadata",
        ceilingUsd: 0.6,
        requests: 1,
        tokens: 100,
        maxJobUsd: 1,
        maxDayUsd: 1,
        maxDayRequests: 10,
        maxDayTokens: 1000,
      },
      store,
    );
    process.send?.({ accepted: reservation.id });
  } catch (error) {
    process.send?.({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
process.send?.({ ready: true });
