import { MAX_NETWORK_RETRIES, NETWORK_RETRY_DELAYS_MS } from './constants.ts';
import { Logger } from '../../logger.ts';

const log = new Logger('retry-utils');

export interface RetryOptions {
  maxRetries?: number;
  delaysMs?: readonly number[];
  onRetry?: (attempt: number, error: unknown) => void;
  isRetryable?: (error: unknown) => boolean;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? MAX_NETWORK_RETRIES;
  const delays = options?.delaysMs ?? NETWORK_RETRY_DELAYS_MS;
  const isRetryable = options?.isRetryable ?? (() => true);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isLast = attempt >= maxRetries;
      const shouldRetry = isRetryable(err);

      if (isLast || !shouldRetry) {
        throw err;
      }

      const delayMs = delays[attempt] ?? delays[delays.length - 1] ?? 5_000;

      log.warn(
        `retryWithBackoff: attempt ${attempt + 1} failed (${err instanceof Error ? err.message : String(err)}). ` +
          `Retrying in ${delayMs}ms (${maxRetries - attempt} attempt(s) left)`
      );

      options?.onRetry?.(attempt + 1, err);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export function parseRetryAfter(
  headers: Record<string, string | string[] | undefined>
): number | null {
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return null;

  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;

  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds >= 0 && String(seconds) === value.trim()) {
    return seconds * 1_000;
  }

  const date = new Date(value).getTime();
  if (!isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
