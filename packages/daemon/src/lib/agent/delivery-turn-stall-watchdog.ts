/**
 * No-progress stall watchdog for a delivery-driven SDK turn.
 *
 * A healthy turn — even a multi-hour agentic one — emits SDK messages
 * (assistant output, tool events, system events) continuously, so it is NEVER
 * silent for long. This watchdog catches the opposite: a turn that consumed the
 * kickoff and then went SILENT — no SDK message and no outstanding tool — for a
 * sustained window, which is a true query hang (the 60s lease heartbeat would
 * otherwise pin the job `processing` forever and the UI would show "delivered"
 * indefinitely).
 *
 * It is activity-aware:
 *   - `bump()` resets the no-activity window; the SDK message handler calls it
 *     on EVERY incoming message.
 *   - on each fire attempt, if a tool is mid-execution (`hasOutstandingTool`),
 *     the fire is deferred (re-armed) — a quiet window during a tool run is the
 *     tool executing, not a stall.
 *   - likewise if `isPaused` reports a scheduled rate-limit cooldown: the query
 *     intentionally emits nothing while the provider's reset window elapses, and
 *     firing would `resetQuery()` → cancel the cooldown timer and re-drive the
 *     provider early. Silence there is scheduled, not a stall. (Codex P1.)
 *
 * `arm()` returns a promise that resolves when a TRUE stall fires (after running
 * `onFire`, e.g. resetting the zombie query). Extracted from AgentSession so the
 * reset / defer / fire logic is unit-testable in isolation.
 */
export class DeliveryTurnStallWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolveFire: (() => void) | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly hasOutstandingTool: () => boolean,
    private readonly onFire?: () => void | Promise<void>,
    private readonly isPaused?: () => boolean
  ) {}

  /** Arm the watchdog. Resolves on a true (no-activity, no-tool) stall fire. */
  arm(): Promise<void> {
    this.cancel();
    return new Promise<void>((resolve) => {
      this.resolveFire = resolve;
      this.schedule();
    });
  }

  /** Reset the no-activity window (an SDK message arrived). No-op if not armed. */
  bump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.schedule();
    }
  }

  /** Cancel the watchdog (no-op if not armed). */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resolveFire = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.onTick(), this.timeoutMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private async onTick(): Promise<void> {
    // A tool is mid-execution — the turn is quiet but active, not stalled.
    // A scheduled rate-limit cooldown likewise silences the query on purpose.
    if (this.hasOutstandingTool() || this.isPaused?.()) {
      this.schedule();
      return;
    }
    this.timer = null;
    try {
      await this.onFire?.();
    } catch {
      // best-effort — resolve either way so the bridge proceeds
    }
    const resolve = this.resolveFire;
    this.resolveFire = null;
    resolve?.();
  }
}
