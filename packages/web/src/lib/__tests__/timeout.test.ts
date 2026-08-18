// @ts-nocheck

import { createDeferred } from '../timeout';

describe('createDeferred', () => {
  it('should create a promise that can be resolved externally', async () => {
    const { promise, resolve } = createDeferred<string>();

    setTimeout(() => resolve('resolved'), 10);

    const result = await promise;
    expect(result).toBe('resolved');
  });

  it('should create a promise that can be rejected externally', async () => {
    const { promise, reject } = createDeferred<string>();

    setTimeout(() => reject(new Error('rejected')), 10);

    await expect(promise).rejects.toThrow('rejected');
  });

  it('should resolve immediately when called synchronously', async () => {
    const { promise, resolve } = createDeferred<number>();
    resolve(42);
    const result = await promise;
    expect(result).toBe(42);
  });
});
