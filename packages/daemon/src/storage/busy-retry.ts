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

export function withBusyRetry<T>(operation: () => T, options: BusyRetryOptions = {}): T {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? sleepSync;

  for (let attempt = 1; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= maxAttempts) throw error;
      sleep(baseDelayMs * 2 ** (attempt - 1));
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
