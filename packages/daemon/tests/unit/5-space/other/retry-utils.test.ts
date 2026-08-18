import { describe, test, expect } from 'bun:test';
import {
  retryWithBackoff,
  parseRetryAfter,
} from '../../../../src/lib/space/runtime/retry-utils.ts';
import { MAX_NETWORK_RETRIES } from '../../../../src/lib/space/runtime/constants.ts';

function makeFlaky(failCount: number, result = 'ok'): () => Promise<string> {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= failCount) throw new Error(`fail attempt ${calls}`);
    return result;
  };
}

function makeAlwaysFail(msg = 'permanent error'): () => Promise<never> {
  return async () => {
    throw new Error(msg);
  };
}

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
    expect(callCount).toBe(1);
  });

  test('isRetryable: retryable errors are retried; non-retryable throws immediately', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('network error');
      if (callCount === 2) throw new Error('auth error');
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
    const fn = makeAlwaysFail('err');
    await expect(retryWithBackoff(fn, { maxRetries: 3, delaysMs: [0] })).rejects.toThrow('err');
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
    expect(callCount).toBe(MAX_NETWORK_RETRIES + 1);
  });
});

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
    expect(ms).toBeLessThanOrEqual(10_000 + 100);
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
    const ms = parseRetryAfter({ 'retry-after': '10', 'Retry-After': '20' });
    expect(ms).toBeGreaterThan(0);
  });
});
