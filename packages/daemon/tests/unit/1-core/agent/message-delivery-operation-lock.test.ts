import { afterEach, describe, expect, it } from 'bun:test';
import {
  sessionOperationLockArmedAtCountForTest,
  withSessionOperationLock,
} from '../../../../src/lib/agent/message-delivery';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const resetEnv = (): void => {
  delete process.env.HYPERNEO_OPERATION_LOCK_ACQUIRE_TIMEOUT_MS;
  delete process.env.HYPERNEO_OPERATION_LOCK_LEAK_CEILING_MS;
};

const slowResolve = (ms: number) =>
  new Promise<string>((resolve) => setTimeout(() => resolve('slow'), ms));

describe('withSessionOperationLock', () => {
  afterEach(() => {
    resetEnv();
  });

  it('serializes operations for the same session', async () => {
    const order: string[] = [];
    const first = withSessionOperationLock('s', async () => {
      order.push('first-start');
      await tick(5);
      order.push('first-end');
      return 1;
    });
    const second = withSessionOperationLock('s', async () => {
      order.push('second-start');
      return 2;
    });

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('clears the holder timestamp once the last operation for a session completes', async () => {
    expect(sessionOperationLockArmedAtCountForTest()).toBe(0);

    await withSessionOperationLock('s', async () => 'a');
    await withSessionOperationLock('s', async () => 'b');

    expect(sessionOperationLockArmedAtCountForTest()).toBe(0);
  });

  it('runs different sessions concurrently', async () => {
    let started = 0;
    const first = withSessionOperationLock('a', async () => {
      started += 1;
      await tick(10);
      return 'a';
    });
    const second = withSessionOperationLock('b', async () => {
      started += 1;
      return 'b';
    });

    await expect(first).resolves.toBe('a');
    await expect(second).resolves.toBe('b');
    expect(started).toBe(2);
  });

  it('continues after a rejected holder', async () => {
    const first = withSessionOperationLock('s', async () => {
      throw new Error('holder failed');
    });
    const second = withSessionOperationLock('s', async () => 'next');

    await expect(first).rejects.toThrow('holder failed');
    await expect(second).resolves.toBe('next');
  });

  it('times out when a prior holder does not settle', async () => {
    process.env.HYPERNEO_OPERATION_LOCK_ACQUIRE_TIMEOUT_MS = '10';

    const slow = withSessionOperationLock('s', () => slowResolve(50));
    await tick(0);

    const waiter = withSessionOperationLock('s', async () => 'waiter');
    await expect(waiter).rejects.toBeInstanceOf(DOMException);

    await expect(slow).resolves.toBe('slow');
  });

  it('cleans up a timed-out waiter so the next operation can proceed', async () => {
    process.env.HYPERNEO_OPERATION_LOCK_ACQUIRE_TIMEOUT_MS = '10';
    process.env.HYPERNEO_OPERATION_LOCK_LEAK_CEILING_MS = '20';

    const slow = withSessionOperationLock('s', () => slowResolve(50));
    await tick(0);

    const waiter = withSessionOperationLock('s', async () => 'waiter');
    await expect(waiter).rejects.toBeInstanceOf(DOMException);

    await tick(30);

    const next = withSessionOperationLock('s', async () => 'next');
    await expect(next).resolves.toBe('next');

    await expect(slow).resolves.toBe('slow');
  });

  it('a timed-out waiter with a successor does not reclaim the successor chain', async () => {
    process.env.HYPERNEO_OPERATION_LOCK_ACQUIRE_TIMEOUT_MS = '20';
    process.env.HYPERNEO_OPERATION_LOCK_LEAK_CEILING_MS = '60';

    const stuck = withSessionOperationLock('s', () => new Promise<string>(() => {}));
    await tick(50);

    const ran: string[] = [];
    const waiterA = withSessionOperationLock('s', async () => {
      ran.push('A');
      return 'A';
    });
    await tick(0);
    const waiterB = withSessionOperationLock('s', async () => {
      ran.push('B');
      return 'B';
    });

    await expect(waiterA).rejects.toBeInstanceOf(DOMException);
    await expect(waiterB).resolves.toBe('B');
    expect(ran).toEqual(['B']);
    void stuck;
  });
});
