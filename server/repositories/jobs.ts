import type { Store } from "../db";
import type { JobState } from "../../lib/types";
export const jobRepository = (store: Store) => ({
  list: () => store.list<JobState>("legacy-jobs").map((r) => r.value),
  save: (job: JobState) =>
    store.mutate(
      "legacy-jobs",
      job.id,
      () => job,
      () => job,
    ),
});
