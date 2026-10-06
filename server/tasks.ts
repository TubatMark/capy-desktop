import type { QueueEntry, StoryAssessment, StorySeries, StoryState, TodoTask } from "../lib/types";

/**
 * The user's To do, derived from the stories and the queue (never stored, so it's always current). A story's
 * script or video becomes a task only after the assessor has looked at it.
 */

const TONE_ORDER: Record<TodoTask["tone"], number> = { block: 0, action: 1, warn: 2 };
const top = (a: StoryAssessment, n = 2) => a.fixes.slice(0, n).map((f) => f.note).join(" · ");

export function tasksFrom(stories: StoryState[], series: StorySeries[], queue: QueueEntry[]): TodoTask[] {
  const out: TodoTask[] = [];
  const name = new Map(series.map((s) => [s.id, s.title]));
  for (const st of stories) {
    const href = `/stories/${st.seriesId}/${st.id}`;
    const t = `“${st.title}”`;
    const base = { href, at: st.updatedAt };
    const where = name.get(st.seriesId);
    if (st.status === "error") {
      out.push({ ...base, id: `${st.id}:error`, kind: "error", tone: "block", title: `${t} needs attention`, detail: st.error ?? (where ? `In ${where}` : undefined) });
      continue;
    }
    if (st.status === "script") {
      const a = st.assessments?.script;
      if (!a || st.assessing) continue; // the assessor hands it over once it has looked
      if (a.error) {
        out.push({ ...base, id: `${st.id}:script`, kind: "error", tone: "warn", title: `Check ${t} again`, detail: `The assessor couldn't run: ${a.error}` });
        continue;
      }
      if (a.verdict === "block") out.push({ ...base, id: `${st.id}:script`, kind: "fix", tone: "block", title: `Rewrite ${t}`, detail: top(a), overall: a.overall });
      else
        out.push({
          ...base,
          id: `${st.id}:script`,
          kind: "script",
          tone: a.verdict === "ready" ? "action" : "warn",
          title: `Review the script of ${t}`,
          detail: a.verdict === "ready" ? (a.strengths[0] ? `Assessor: ${a.strengths[0]}` : "The assessor says it's ready for pictures.") : top(a),
          overall: a.overall,
        });
      continue;
    }
    if (st.status === "pages") {
      const missing = st.pages.filter((p) => p.status !== "ready").length;
      out.push({ ...base, id: `${st.id}:pages`, kind: "pictures", tone: "action", title: missing ? `Draw the missing pages of ${t}` : `Make the video for ${t}`, detail: missing ? `${missing} page${missing === 1 ? "" : "s"} still to draw` : "Every page is drawn." });
      continue;
    }
    if (st.status === "done" && !st.queuedAt) {
      const a = st.assessments?.video;
      if (!a || st.assessing) continue;
      if (a.error) out.push({ ...base, id: `${st.id}:video`, kind: "error", tone: "warn", title: `Check ${t} again`, detail: `The assessor couldn't run: ${a.error}` });
      else if (a.verdict === "ready") out.push({ ...base, id: `${st.id}:video`, kind: "send", tone: "action", title: `Watch ${t} and send it to Queue`, detail: a.strengths[0] ? `Assessor: ${a.strengths[0]}` : undefined, overall: a.overall });
      else out.push({ ...base, id: `${st.id}:video`, kind: "fix", tone: a.verdict === "block" ? "block" : "warn", title: `Fix ${t} before it goes out`, detail: top(a), overall: a.overall });
    }
  }
  const waiting = new Set(queue.filter((e) => e.status === "review").map((e) => `${e.jobId}:${e.n}`));
  if (waiting.size) {
    const latest = Math.max(...queue.filter((e) => e.status === "review").map((e) => e.updatedAt));
    out.push({ id: "queue", kind: "queue", tone: "action", href: "/queue", title: `Approve ${waiting.size} video${waiting.size === 1 ? "" : "s"} waiting in Queue`, detail: "Watch each one and pick a time, or reject it.", at: latest });
  }
  return out.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || b.at - a.at);
}
