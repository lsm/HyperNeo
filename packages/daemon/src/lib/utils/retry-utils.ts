import { sleep } from './sleep.ts';
import { MAX_NETWORK_RETRIES, NETWORK_RETRY_DELAYS_MS } from '../space/runtime/constants.ts';
import { Logger } from '../logger.ts';

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
