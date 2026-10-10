import { jobs } from "../jobs";
import { registerWork } from "./registry";
export function registerMediaWorkers() {
  registerWork("media", (lease) => [
    {
      name: "pipeline",
      expensive: true,
      run: async () => {
        try {
          await jobs().executeWork(lease);
        } catch (error) {
          jobs().workerFailure(lease, error);
          throw error;
        }
      },
    },
  ]);
}
