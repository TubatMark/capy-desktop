import { runtimeStore } from "@/server/db/runtime";
import type { JobState } from "@/lib/types";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(
    runtimeStore()
      .list<JobState>("legacy-jobs")
      .map((r) => ({
        id: r.id,
        title: r.value.title ?? r.id,
        duration: r.value.duration,
        clips: r.value.clips.map((c) => ({
          n: c.n,
          title: c.title,
          start: c.start,
          end: c.end,
        })),
      })),
  );
}
