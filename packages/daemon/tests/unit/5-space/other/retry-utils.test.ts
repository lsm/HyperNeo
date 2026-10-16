import { describe, test, expect } from 'bun:test';
import { retryWithBackoff } from '../../../../src/lib/utils/retry-utils.ts';
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
