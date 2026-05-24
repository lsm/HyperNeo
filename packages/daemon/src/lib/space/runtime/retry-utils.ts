/**
 * Retry Utilities (M9.4)
 *
 * Generic retry-with-backoff and Retry-After header parsing for transient
 * network errors such as `gh` CLI command failures and HTTP rate limits.
 *
 * ## Usage
 *
 * ```ts
 * // Retry a network operation with default backoff (5s, 10s, 20s, max 3 retries)
 * const result = await retryWithBackoff(() => runGhCommand(['pr', 'create']));
 *
 * // Custom retry options
 * const result = await retryWithBackoff(
 *   () => fetchSomething(),
 *   { maxRetries: 2, delaysMs: [1000, 2000] }
 * );
 * ```
 */

import { MAX_NETWORK_RETRIES, NETWORK_RETRY_DELAYS_MS } from './constants';
import { Logger } from '../../logger';

const log = new Logger('retry-utils');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /**
   * Maximum number of retry attempts (not counting the initial attempt).
   * Default: MAX_NETWORK_RETRIES (3).
   */
  maxRetries?: number;
  /**
   * Delay in milliseconds before each retry attempt.
   * Index 0 = before attempt 2, index 1 = before attempt 3, etc.
   * The last entry is reused if there are more retries than entries.
   * Default: NETWORK_RETRY_DELAYS_MS ([5000, 10000, 20000]).
   */
  delaysMs?: readonly number[];
  /**
   * Optional callback called before each retry attempt.
   * Receives the 1-based retry number and the error that triggered the retry.
   */
  onRetry?: (attempt: number, error: unknown) => void;
  /**
   * Optional predicate to decide if an error is retryable.
   * If not provided, all errors are retried.
   */
  isRetryable?: (error: unknown) => boolean;
}

// ---------------------------------------------------------------------------
// retryWithBackoff
// ---------------------------------------------------------------------------

/**
 * Executes `fn` up to `maxRetries + 1` times, waiting between each attempt.
 *
 * If all attempts fail, the last error is re-thrown.
 * If `isRetryable` is provided and returns `false` for an error, that error
 * is thrown immediately without further retries.
 *
 * @param fn          Async function to execute (called once initially, then up to maxRetries times).
 * @param options     Retry configuration (see RetryOptions).
 * @returns           The resolved value from `fn` on a successful attempt.
 * @throws            The last error if all attempts fail.
 */
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
        // Exhausted retries or non-retryable error — propagate immediately.
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

  // Unreachable: loop always exits via return or throw above.
  throw lastError;
}

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------

/**
 * Parses the `Retry-After` HTTP header and returns the wait duration in
 * milliseconds.
 *
 * Supports two formats:
 *   - Seconds (integer): `Retry-After: 30` → 30 000 ms
 *   - HTTP date:         `Retry-After: Wed, 01 Jan 2025 00:00:00 GMT` → ms until that date
 *
 * Returns `null` if the header is absent or cannot be parsed.
 * Returns `0` if the date is in the past.
 *
 * @param headers  Header map — keys may be any case (`retry-after` or `Retry-After`).
 */
export function parseRetryAfter(
  headers: Record<string, string | string[] | undefined>
): number | null {
  // Header lookup is case-insensitive — check both common cases.
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return null;

  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;

  // Try integer seconds first.
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds >= 0 && String(seconds) === value.trim()) {
    return seconds * 1_000;
  }

  // Try HTTP date format.
  const date = new Date(value).getTime();
  if (!isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
