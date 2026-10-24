import { Logger } from '../logger.ts';

const logger = new Logger('sdk-startup-gate');
export const DEFAULT_SDK_STARTUP_MAX_HOLD_MS = 60_000;

export const DEFAULT_SDK_STARTUP_MAX_CONCURRENT = 3;

export function getSdkStartupMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;
  if (!raw) return DEFAULT_SDK_STARTUP_MAX_CONCURRENT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SDK_STARTUP_MAX_CONCURRENT;
}

export function getSdkStartupMaxHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYPERNEO_SDK_STARTUP_MAX_HOLD_MS;
  if (!raw) return DEFAULT_SDK_STARTUP_MAX_HOLD_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SDK_STARTUP_MAX_HOLD_MS;
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
  setPhase(phase: string): void;
  release(): boolean;
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
  private holders = new Map<symbol, { sessionId: string; admittedAt: number; phase: string }>();

  constructor(private readonly maxHoldMs = getSdkStartupMaxHoldMs()) {}

  private describeHolders(): string {
    return JSON.stringify(
      [...this.holders.values()].map((holder) => ({
        ...holder,
        heldMs: Date.now() - holder.admittedAt,
      }))
    );
  }

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
      logger.warn(
        `SDK startup gate: waiting session=${sessionId} holders=${this.describeHolders()}`
      );
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
    const key = Symbol(sessionId);
    const holder = { sessionId, admittedAt: Date.now(), phase: 'provider_environment' };
    this.holders.set(key, holder);
    logger.warn(
      `SDK startup gate: admitted session=${sessionId} waitedMs=${waitedMs} ` +
        `maxHoldMs=${this.maxHoldMs} holders=${this.describeHolders()}`
    );
    const timer = setTimeout(() => {
      logger.warn(
        `SDK startup gate: hold expired session=${sessionId} phase=${holder.phase} ` +
          `heldMs=${Date.now() - holder.admittedAt} holders=${this.describeHolders()}`
      );
      permit.release();
    }, this.maxHoldMs);
    timer.unref?.();
    const permit: SdkStartupPermit = {
      sessionId,
      queuedBehind,
      waitedMs,
      admittedAt: holder.admittedAt,
      setPhase: (phase) => {
        holder.phase = phase;
      },
      release: () => {
        if (released) return false;
        released = true;
        clearTimeout(timer);
        this.holders.delete(key);
        logger.warn(
          `SDK startup gate: released session=${sessionId} phase=${holder.phase} ` +
            `heldMs=${Date.now() - holder.admittedAt}`
        );
        const next = this.waiters.shift();
        if (next) {
          next.grant();
        } else {
          this.active = Math.max(0, this.active - 1);
        }
        return true;
      },
    };
    return permit;
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
