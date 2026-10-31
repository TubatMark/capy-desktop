import { maybeRunDailyCheck } from "../daily-check";
import { autopilotTick } from "./autopilot";
import { LONG_FOLDER } from "./store";
import { enqueueWork } from "../worker/api";
import { registerWork } from "../worker/registry";
import { markFailed, runStep, type Step } from "./worker";

export const LONG_KIND = "longform";
/** Separate, so pausing posting pauses uploads too. */
export const LONG_UPLOAD_KIND = "longform-upload";
const OBSERVE_MS = 5 * 60_000;
export { LONG_FOLDER };

const stepKind = (s: Step) => (s.step === "upload" || s.step === "observe" ? LONG_UPLOAD_KIND : LONG_KIND);

export function queueStep(s: Step, now = Date.now()) {
  return enqueueWork({
    kind: stepKind(s),
    workKey: `longform:${s.id}:${s.step}:${s.index ?? 0}`,
    inputRevision: now,
    payload: { ...s, jobId: `longform:${s.id}` },
  });
}

export function registerLongFormWorkers() {
  const factory = (lease: { payload: Record<string, unknown>; attempts: number }) => {
    const s = lease.payload as unknown as Step;
    return [
      {
        name: s.step,
        expensive: s.step !== "observe",
        ai: s.step === "plan",
        timeoutMs: 45 * 60_000,
        run: async () => {
          try {
            const next = await runStep(s);
            if (next) await queueStep(next);
            if (s.step === "observe") {
              await autopilotTick((step) => queueStep(step));
              await maybeRunDailyCheck().catch((e) => console.error("[daily check]", e));
            }
          } catch (e) {
            // an upload may just have lost the network: let the worker try it again first
            if (s.step === "upload" && lease.attempts < 3) throw e;
            markFailed(s, e);
            throw Object.assign(e instanceof Error ? e : new Error(String(e)), { retryable: false });
          }
        },
      },
    ];
  };
  registerWork(LONG_KIND, factory);
  registerWork(LONG_UPLOAD_KIND, factory);
}

let lastObserve = 0;
export async function maybeObserveLongForm(now = Date.now()) {
  if (now - lastObserve < OBSERVE_MS) return;
  lastObserve = now;
  await enqueueWork({ kind: LONG_UPLOAD_KIND, workKey: "longform:observe", inputRevision: Math.floor(now / OBSERVE_MS), payload: { id: "", step: "observe" } });
}
