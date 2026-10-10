import { jobs } from "@/server/jobs";
import type { JobState } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Server-sent events: the full job state on every change, plus a heartbeat. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const m = jobs();
  await m.init();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (job: JobState) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(job)}\n\n`));
        } catch {
          /* closed */
        }
      };
      const current = m.get(id);
      if (current) send(current);
      let last = JSON.stringify(current);
      // The worker is another process; observe committed snapshots rather than its EventEmitter.
      const poll = setInterval(() => {
        const job = m.get(id);
        const next = JSON.stringify(job);
        if (job && next !== last) {
          last = next;
          send(job);
        }
      }, 500);
      const beat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 15000);
      req.signal.addEventListener("abort", () => {
        clearInterval(poll);
        clearInterval(beat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
