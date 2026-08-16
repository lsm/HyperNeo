/**
 * Daemon-wide admission gate for SDK subprocess cold-starts.
 *
 * The expensive resource during a session start is the spawn→first-message
 * window — fork/exec of the CLI, transcript parse, and startup work — not
 * steady-state streaming, which is cheap. Without a bound, a reclaimed herd of
 * N stale deliveries spawns N SDK subprocesses simultaneously and every one of
 * them can miss the startup window (solo cold-start is ~4-5s; 10 concurrent
 * pushes each past 15s). This gate decouples the two: it bounds how many
 * sessions daemon-wide may be in the pre-first-message phase at once, while
 * delivery-slot semantics (concurrent turns) stay unchanged.
 *
 * A session acquires a permit immediately before the SDK spawns its subprocess
 * and releases it when the first SDK message arrives (the same point the
 * query-runner clears the startup timer), or when the attempt exits without a
 * first message (startup-timeout abort, process exit, error, retry). Queued
 * sessions are admitted FIFO as slots free, so a streaming session never
 * blocks admission — no starvation.
 *
 * The concurrency cap is read lazily at acquire time (not module load) so
 * tests can override HYPERNEO_SDK_STARTUP_MAX_CONCURRENT per-case, matching
 * the provider-retry env pattern in query-runner.ts.
 */

/** Default cap on concurrent spawn→first-message phases (per daemon). */
export const DEFAULT_SDK_STARTUP_MAX_CONCURRENT = 3;

/**
 * Parse HYPERNEO_SDK_STARTUP_MAX_CONCURRENT. Unset, 0, negative, or
 * non-numeric values fall back to the default — the gate is a hard guarantee
 * and must never be accidentally disabled; raise the number to loosen it.
 */
export function getSdkStartupMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;
  if (!raw) return DEFAULT_SDK_STARTUP_MAX_CONCURRENT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SDK_STARTUP_MAX_CONCURRENT;
}

function createGateAbortError(): Error {
  const error = new Error('SDK startup gate: admission aborted');
  error.name = 'AbortError';
  return error;
}

/** Opaque admission permit. `release()` is idempotent and hands the slot onward. */
export interface SdkStartupPermit {
  readonly sessionId: string;
  /** Waiters already queued when this acquire enqueued (0 = fast path). */
  readonly queuedBehind: number;
  /** Milliseconds spent waiting for admission (0 on the fast path). */
  readonly waitedMs: number;
  /** Epoch ms when the permit was granted — caller computes heldMs for logs. */
  readonly admittedAt: number;
  release(): void;
}

export interface SdkStartupGateStats {
  active: number;
  queued: number;
  maxConcurrent: number;
}

interface GateWaiter {
  sessionId: string;
  grant(): void;
}

/**
 * Counting semaphore with FIFO admission. Daemon-wide singleton via
 * {@link getSdkStartupGate}; the class is exported for direct unit testing.
 */
export class SdkStartupConcurrencyGate {
  private active = 0;
  private waiters: GateWaiter[] = [];

  getStats(): SdkStartupGateStats {
    return {
      active: this.active,
      queued: this.waiters.length,
      maxConcurrent: getSdkStartupMaxConcurrent(),
    };
  }

  /**
   * Acquire a startup-phase slot, queueing FIFO when the cap is reached.
   *
   * `signal` aborts the wait (stop/interrupt/restart) by rejecting with an
   * AbortError and dequeuing — an aborted waiter must never receive a slot
   * later and spawn an orphaned subprocess. The slot-transfer in release()
   * keeps `active` unchanged while handing a slot to the next waiter, so a
   * synchronous acquire racing a release can never exceed the cap (a naive
   * decrement-then-wake would let a fast-path acquire steal the waking
   * waiter's slot).
   */
  async acquire(options: { sessionId: string; signal?: AbortSignal }): Promise<SdkStartupPermit> {
    const { sessionId, signal } = options;
    if (signal?.aborted) throw createGateAbortError();

    let queuedBehind = 0;
    let waitedMs = 0;
    if (this.active < getSdkStartupMaxConcurrent()) {
      this.active++;
    } else {
      queuedBehind = this.waiters.length;
      const waitStart = Date.now();
      await this.waitForSlot(sessionId, signal);
      waitedMs = Date.now() - waitStart;
      // The grant and an abort can interleave while the grant microtask is
      // queued: the slot is ours, but the attempt is dead. Hand the slot
      // onward (release drains the queue) and surface the abort.
      if (signal?.aborted) {
        this.createPermit(sessionId, 0, 0).release();
        throw createGateAbortError();
      }
    }
    return this.createPermit(sessionId, queuedBehind, waitedMs);
  }

  private waitForSlot(sessionId: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Called only after the executor's synchronous body completes, so the
      // mutual references between `waiter` and `onAbort` are initialized.
      const waiter: GateWaiter = {
        sessionId,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
        reject(createGateAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private createPermit(
    sessionId: string,
    queuedBehind: number,
    waitedMs: number
  ): SdkStartupPermit {
    let released = false;
    return {
      sessionId,
      queuedBehind,
      waitedMs,
      admittedAt: Date.now(),
      release: () => {
        if (released) return;
        released = true;
        const next = this.waiters.shift();
        if (next) {
          // Transfer the slot directly — `active` already counts the next
          // holder, so no intervening fast-path acquire can overshoot the cap.
          next.grant();
        } else {
          this.active = Math.max(0, this.active - 1);
        }
      },
    };
  }
}

let gateInstance: SdkStartupConcurrencyGate | null = null;

/** The daemon-wide startup gate. Shared by every QueryRunner instance. */
export function getSdkStartupGate(): SdkStartupConcurrencyGate {
  if (!gateInstance) gateInstance = new SdkStartupConcurrencyGate();
  return gateInstance;
}

/** Test-only: drop the singleton so a new gate starts with clean counters. */
export function resetSdkStartupGateForTests(): void {
  gateInstance = null;
}
