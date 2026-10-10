import { currentSignal } from "../../src/exec";
import { assertWork } from "./context";
/** Every provider request is fenced at admission and bounded; retries re-enter this check. */
export const scopedFetch: typeof fetch = async (input, init) => {
  assertWork();
  const signals = [
    AbortSignal.timeout(Number(process.env.CAPY_HTTP_TIMEOUT_MS ?? 30_000)),
  ];
  const cancellation = currentSignal();
  if (cancellation) signals.push(cancellation);
  if (init?.signal) signals.push(init.signal);
  const response = await fetch(input, {
    ...init,
    signal: AbortSignal.any(signals),
  });
  assertWork();
  return response;
};
