import type { TodoTask } from "../lib/types";
import { queue } from "./queue";
import { stories } from "./stories";
import { automationHealth } from "./worker/health";
import { automationTasks, tasksFrom } from "./tasks";

/** The user's To do right now: stories the assessor has handed over, and clips waiting in Queue. */
export async function currentTasks(): Promise<TodoTask[]> {
  const m = stories();
  await m.init();
  const health=await automationHealth();
  return [...automationTasks(health.reasons), ...tasksFrom([...m.stories.values()], m.listSeries(), queue().list())];
}
