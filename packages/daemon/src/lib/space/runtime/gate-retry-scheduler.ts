/**
 * Shared scheduler for gate-data refresh retries after rate-limited gate
 * evaluations.
 *
 * Multiple `ChannelRouter` instances can reference the same scheduler so that
 * retries for the same `runId:gateId` are coalesced across the transient routers
 * created by `SpaceRuntimeService.notifyGateDataChanged`.
 */
export class GateRetryScheduler {
  private readonly pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingFireAt = new Map<string, number>();

  /**
   * Schedules `callback` to run after `retryAfterMs` for the given gate.
   *
   * If a pending retry for the same gate already exists with a later (or equal)
   * fire time, the existing timer is kept. Otherwise the old timer is cancelled
   * and replaced. This preserves the longest cooldown across concurrent or
   * overlapping refresh attempts.
   */
  schedule(runId: string, gateId: string, retryAfterMs: number, callback: () => void): void {
    const key = `${runId}:${gateId}`;
    const newFireAt = Date.now() + retryAfterMs;
    const existingFireAt = this.pendingFireAt.get(key);
    if (existingFireAt !== undefined && newFireAt <= existingFireAt) {
      return;
    }

    const existingTimer = this.pendingRetries.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.pendingRetries.delete(key);
      this.pendingFireAt.delete(key);
      callback();
    }, retryAfterMs);
    timer.unref?.();

    this.pendingRetries.set(key, timer);
    this.pendingFireAt.set(key, newFireAt);
  }

  /**
   * Cancels any pending retry for the given gate.
   */
  cancel(runId: string, gateId: string): void {
    const key = `${runId}:${gateId}`;
    const existingTimer = this.pendingRetries.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    this.pendingRetries.delete(key);
    this.pendingFireAt.delete(key);
  }

  /**
   * Returns true if a retry is currently scheduled for the gate.
   */
  has(runId: string, gateId: string): boolean {
    return this.pendingRetries.has(`${runId}:${gateId}`);
  }

  /**
   * Returns the scheduled fire epoch (ms) for a gate, or undefined if none.
   */
  getFireAt(runId: string, gateId: string): number | undefined {
    return this.pendingFireAt.get(`${runId}:${gateId}`);
  }
}
