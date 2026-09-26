import { runChecks } from "@/server/doctor";
import { saveSettings } from "@/server/settings";
import type { CheckResult } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Server-sent events: `event: check` with a CheckResult per line of the setup check, then
 * `event: done` with `{ problems }`. Records `checkedAt` in settings when it completes.
 */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* closed */
        }
      };
      const beat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 10000);
      let problems = 0;
      try {
        for await (const r of runChecks()) {
          if (req.signal.aborted) break;
          const result: CheckResult = r;
          if (!result.ok) problems++;
          send("check", result);
        }
        if (!req.signal.aborted) {
          saveSettings({ checkedAt: Date.now() });
          send("done", { problems });
        }
      } catch (e) {
        send("done", { problems: problems + 1, error: e instanceof Error ? e.message : String(e) });
      } finally {
        clearInterval(beat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
