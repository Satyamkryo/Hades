import { HadesAbortError } from "./errors.js";

/** Throw HadesAbortError if the signal is aborted. Native throwIfAborted throws AbortError. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HadesAbortError();
}

/**
 * Combine a timeout with a run signal without AbortSignal.any (unavailable on Node 20.0).
 * Returns a signal that aborts when either aborts, plus a cleanup function.
 * If the run signal aborts, the combined signal aborts too; callers check
 * runSignal.aborted to decide between HadesAbortError and a timeout error.
 */
export function combineWithTimeout(
  timeoutMs: number,
  runSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const onTimeout = (): void => controller.abort(timeoutSignal.reason);
  const onRunAbort = (): void => controller.abort(runSignal?.reason);
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  if (runSignal?.aborted) {
    controller.abort(runSignal.reason);
  } else {
    runSignal?.addEventListener("abort", onRunAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      timeoutSignal.removeEventListener("abort", onTimeout);
      runSignal?.removeEventListener("abort", onRunAbort);
    },
  };
}
