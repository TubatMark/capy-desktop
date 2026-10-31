import type { TodoTask } from "../lib/types";
import { publicAccounts } from "./accounts";
import { listVideos } from "./longform/store";
import { queue } from "./queue";
import { effective } from "./settings";
import { todoTasks } from "./tasks";
import { workQueue } from "./worker/api";

/** The user's To do right now. Cheap enough for the sidebar badge: it only reads saved state. */
export async function currentTasks(): Promise<TodoTask[]> {
  return todoTasks({
    work: workQueue().list(),
    queue: queue().list(),
    videos: listVideos(),
    accounts: publicAccounts(),
    autoSchedule: effective().autoSchedule,
    now: Date.now(),
  });
}
