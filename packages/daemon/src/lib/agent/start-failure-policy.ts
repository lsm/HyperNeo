export const START_FAILURE_LIMIT = 3;

export const START_FAILURE_BACKOFF_CAP_MS = 60_000;

export function startFailureBackoffMs(failureCount: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failureCount - 1), START_FAILURE_BACKOFF_CAP_MS);
}

export function startFailureDecision(
  failureCount: number
): { failed: true } | { failed: false; parkMs: number } {
  return failureCount >= START_FAILURE_LIMIT
    ? { failed: true }
    : { failed: false, parkMs: startFailureBackoffMs(failureCount) };
}
