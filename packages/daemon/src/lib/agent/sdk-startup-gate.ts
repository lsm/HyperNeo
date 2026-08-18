export const DEFAULT_SDK_STARTUP_MAX_CONCURRENT = 3;

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

export interface SdkStartupPermit {
  readonly sessionId: string;
  readonly queuedBehind: number;
  readonly waitedMs: number;
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
      if (signal?.aborted) {
        this.createPermit(sessionId, 0, 0).release();
        throw createGateAbortError();
      }
    }
    return this.createPermit(sessionId, queuedBehind, waitedMs);
  }

  private waitForSlot(sessionId: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
          next.grant();
        } else {
          this.active = Math.max(0, this.active - 1);
        }
      },
    };
  }
}

let gateInstance: SdkStartupConcurrencyGate | null = null;

export function getSdkStartupGate(): SdkStartupConcurrencyGate {
  if (!gateInstance) gateInstance = new SdkStartupConcurrencyGate();
  return gateInstance;
}

export function resetSdkStartupGateForTests(): void {
  gateInstance = null;
}
