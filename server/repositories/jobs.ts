import type { Store } from "../db";
import type { JobState } from "../../lib/types";
import { validateLegacy } from "../db/legacy-validation";
export const jobRepository = (store: Store) => ({
  list: () =>
    store.list<JobState>("legacy-jobs").map((r) => {
      validateLegacy("legacy-jobs", r.id, r.value);
      return r.value;
    }),
  save: (job: JobState) =>
    store.mutate(
      "legacy-jobs",
      job.id,
      () => job,
      () => job,
    ),
});
