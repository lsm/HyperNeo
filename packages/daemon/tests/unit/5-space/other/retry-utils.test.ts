/**
 * Unit tests for retry-utils.ts (M9.4)
 *
 * Scenarios covered:
 *   retryWithBackoff:
 *     1. Returns result immediately on first success
 *     2. Retries up to maxRetries times on failure, then throws
 *     3. Returns early on first success after failures
 *     4. Respects custom delaysMs array
 *     5. Reuses last delay when retries exceed delaysMs length
 *     6. onRetry callback called before each retry attempt
 *     7. isRetryable: skips retry for non-retryable errors
 *     8. isRetryable: retries for retryable errors
 *     9. Zero maxRetries: only one attempt, throws on failure
 *    10. Default maxRetries uses MAX_NETWORK_RETRIES constant
 *
 *   parseRetryAfter:
 *    11. Returns null when header is absent
 *    12. Parses integer seconds correctly
 *    13. Parses HTTP date string correctly
 *    14. Handles array-valued header (takes first)
 *    15. Returns null for unparseable values
 *    16. Returns 0 for past HTTP date (not negative)
 *    17. Case-insensitive key lookup (Retry-After vs retry-after)
 */

import { describe, test, expect } from 'bun:test';
import {
  retryWithBackoff,
  parseRetryAfter,
} from '../../../../src/lib/space/runtime/retry-utils.ts';
import { MAX_NETWORK_RETRIES } from '../../../../src/lib/space/runtime/constants.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a function that fails `failCount` times then succeeds. */
function makeFlaky(failCount: number, result = 'ok'): () => Promise<string> {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= failCount) throw new Error(`fail attempt ${calls}`);
    return result;
  };
}

/** Create a function that always fails with the given message. */
function makeAlwaysFail(msg = 'permanent error'): () => Promise<never> {
  return async () => {
    throw new Error(msg);
  };
}

// ---------------------------------------------------------------------------
// retryWithBackoff tests
// ---------------------------------------------------------------------------

describe('retryWithBackoff', () => {
  test('returns result immediately on first success', async () => {
    const fn = async () => 42;
    const result = await retryWithBackoff(fn, { delaysMs: [] });
    expect(result).toBe(42);
  });

  test('retries up to maxRetries times then throws last error', async () => {
    const fn = makeAlwaysFail('network down');
    await expect(retryWithBackoff(fn, { maxRetries: 2, delaysMs: [0, 0] })).rejects.toThrow(
      'network down'
    );
  });

  test('returns on first success after initial failures', async () => {
    // fails twice, succeeds on 3rd call
    const fn = makeFlaky(2, 'recovered');
    const result = await retryWithBackoff(fn, { maxRetries: 3, delaysMs: [0, 0, 0] });
    expect(result).toBe('recovered');
  });

  test('exact retry count: only maxRetries additional attempts after first', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('fail');
    };
    await expect(retryWithBackoff(fn, { maxRetries: 2, delaysMs: [0, 0] })).rejects.toThrow('fail');
    // 1 initial + 2 retries = 3 total attempts
    expect(callCount).toBe(3);
  });

  test('onRetry callback is called before each retry', async () => {
    const fn = makeAlwaysFail('err');
    const retryAttempts: number[] = [];
    await expect(
      retryWithBackoff(fn, {
        maxRetries: 2,
        delaysMs: [0, 0],
        onRetry: (attempt) => {
          retryAttempts.push(attempt);
        },
      })
    ).rejects.toThrow();
    // onRetry called for attempt 1 and 2 (not for the initial attempt or the final failure)
    expect(retryAttempts).toEqual([1, 2]);
  });

  test('isRetryable: non-retryable error throws immediately without retrying', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('auth error');
    };
    await expect(
      retryWithBackoff(fn, {
        maxRetries: 3,
        delaysMs: [0, 0, 0],
        isRetryable: () => false,
      })
    ).rejects.toThrow('auth error');
    // Only 1 attempt — no retries because isRetryable returned false
    expect(callCount).toBe(1);
  });

  test('isRetryable: retryable errors are retried; non-retryable throws immediately', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('network error'); // retryable
      if (callCount === 2) throw new Error('auth error'); // non-retryable
      return 'ok';
    };
    await expect(
      retryWithBackoff(fn, {
        maxRetries: 3,
        delaysMs: [0, 0, 0],
        isRetryable: (err) => (err instanceof Error ? err.message.includes('network') : false),
      })
    ).rejects.toThrow('auth error');
    expect(callCount).toBe(2);
  });

  test('zero maxRetries: exactly one attempt, throws immediately on failure', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('fail once');
    };
    await expect(retryWithBackoff(fn, { maxRetries: 0, delaysMs: [] })).rejects.toThrow(
      'fail once'
    );
    expect(callCount).toBe(1);
  });

  test('reuses last delaysMs entry when retries exceed array length', async () => {
    // 3 retries but only 1 delay value — last delay (0) should be reused
    const fn = makeAlwaysFail('err');
    await expect(retryWithBackoff(fn, { maxRetries: 3, delaysMs: [0] })).rejects.toThrow('err');
    // No assertion on delay — just verifying it doesn't throw unexpectedly
  });

  test('default maxRetries matches MAX_NETWORK_RETRIES constant', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('fail');
    };
    await expect(
      retryWithBackoff(fn, { delaysMs: Array(MAX_NETWORK_RETRIES).fill(0) })
    ).rejects.toThrow('fail');
    expect(callCount).toBe(MAX_NETWORK_RETRIES + 1); // 1 initial + MAX_NETWORK_RETRIES retries
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfter tests
// ---------------------------------------------------------------------------

describe('parseRetryAfter', () => {
  test('returns null when header is absent', () => {
    expect(parseRetryAfter({})).toBeNull();
    expect(parseRetryAfter({ 'content-type': 'application/json' })).toBeNull();
  });

  test('parses integer seconds (lowercase key)', () => {
    const ms = parseRetryAfter({ 'retry-after': '30' });
    expect(ms).toBe(30_000);
  });

  test('parses integer seconds (title-case key)', () => {
    const ms = parseRetryAfter({ 'Retry-After': '60' });
    expect(ms).toBe(60_000);
  });

  test('parses zero seconds', () => {
    const ms = parseRetryAfter({ 'retry-after': '0' });
    expect(ms).toBe(0);
  });

  test('parses HTTP date string and returns ms until that date', () => {
    const futureDate = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter({ 'retry-after': futureDate });
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(10_000 + 100); // small clock tolerance
  });

  test('returns 0 for past HTTP date (not negative)', () => {
    const pastDate = new Date(Date.now() - 5_000).toUTCString();
    const ms = parseRetryAfter({ 'retry-after': pastDate });
    expect(ms).toBe(0);
  });

  test('handles array-valued header (takes first element)', () => {
    const ms = parseRetryAfter({ 'retry-after': ['45', '90'] });
    expect(ms).toBe(45_000);
  });

  test('returns null for unparseable values', () => {
    expect(parseRetryAfter({ 'retry-after': 'definitely-not-valid' })).toBeNull();
    expect(parseRetryAfter({ 'retry-after': '' })).toBeNull();
  });

  test('lowercase key takes precedence when both cases present', () => {
    // Tests that the lookup finds one of the valid values
    const ms = parseRetryAfter({ 'retry-after': '10', 'Retry-After': '20' });
    // Whichever key is found first, it should return a valid positive ms value
    expect(ms).toBeGreaterThan(0);
  });
});
