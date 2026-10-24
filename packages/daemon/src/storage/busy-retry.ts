import { emitStructuredLogEvent } from '../lib/logger.ts';

const BUSY_MESSAGE_RE = /database is locked|database table is locked/i;

const BUSY_CODE_RE = /^SQLITE_BUSY/i;

export interface BusyRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 25;

export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && BUSY_CODE_RE.test(code)) return true;
  return BUSY_MESSAGE_RE.test(error.message);
}

const busyContexts = new WeakMap<Error, Record<string, unknown>>();

export function rememberBusyContext(error: unknown, context: Record<string, unknown>): void {
  if (error instanceof Error) busyContexts.set(error, { ...busyContexts.get(error), ...context });
}

function reportRetry(metadata: Record<string, unknown>): void {
  emitStructuredLogEvent({
    level: 'warn',
    source: 'logger',
    module: 'hyperneo:daemon:sqlite.query',
    args: ['sqlite.busy_retry'],
    metadata,
  });
}

export function withBusyRetry<T>(operation: () => T, options: BusyRetryOptions = {}): T {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? sleepSync;

  let context: Record<string, unknown> | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      const result = operation();
      if (attempt > 1)
        reportRetry({
          ...context,
          operationPhase: context?.phase ?? 'unknown',
          phase: 'retry',
          attempt,
          outcome: 'ok',
        });
      return result;
    } catch (error) {
      const busy = isSqliteBusyError(error);
      context = error instanceof Error ? busyContexts.get(error) : undefined;
      if (busy || attempt > 1)
        reportRetry({
          ...context,
          operationPhase: context?.phase ?? 'unknown',
          phase: 'retry',
          attempt,
          outcome: busy ? (attempt >= maxAttempts ? 'exhausted' : 'busy') : 'error',
        });
      if (!busy || attempt >= maxAttempts) throw error;
      const requestedMs = baseDelayMs * 2 ** (attempt - 1),
        startedAt = Date.now(),
        started = performance.now();
      let outcome = 'error';
      try {
        sleep(requestedMs);
        outcome = 'ok';
      } finally {
        reportRetry({
          ...context,
          operationPhase: context?.phase ?? 'unknown',
          phase: 'sleep',
          attempt,
          outcome,
          requestedMs,
          startedAt,
          finishedAt: Date.now(),
          durationMs: performance.now() - started,
        });
      }
    }
  }
}

function sleepSync(ms: number): void {
  if (typeof Bun !== 'undefined' && typeof Bun.sleepSync === 'function') {
    Bun.sleepSync(ms);
    return;
  }
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}
