import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import {
  getCoordinationAcquireTimeoutMs,
  getCoordinationLeakCeilingMs,
  SessionCoordinationStallError,
  sessionResetCoordinationLocks,
  withSessionResetCoordination,
} from '../../../../src/lib/agent/message-delivery';

const T0 = new Date('2026-01-01T00:00:00Z').getTime();

const ACQUIRE_ENV = { HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS: '20' };
const CEILING_ENV = { HYPERNEO_DELIVERY_COORDINATION_LEAK_CEILING_MS: '60' };

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('delivery coordination env overrides', () => {
  it('falls back to defaults when unset', () => {
    expect(getCoordinationAcquireTimeoutMs({})).toBe(8_000);
    expect(getCoordinationLeakCeilingMs({})).toBe(900_000);
  });

  it('reads overrides', () => {
    expect(getCoordinationAcquireTimeoutMs(ACQUIRE_ENV)).toBe(20);
    expect(getCoordinationLeakCeilingMs(CEILING_ENV)).toBe(60);
  });
});

describe('withSessionResetCoordination', () => {
  beforeEach(() => {
    process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '20';
    process.env.HYPERNEO_DELIVERY_COORDINATION_LEAK_CEILING_MS = '60';
    sessionResetCoordinationLocks.clear();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
    delete process.env.HYPERNEO_DELIVERY_COORDINATION_LEAK_CEILING_MS;
    sessionResetCoordinationLocks.clear();
    jest.useRealTimers();
  });

  it('serializes holders and returns each result', async () => {
    const order: string[] = [];
    const first = withSessionResetCoordination('s', async () => {
      order.push('first-start');
      await tick();
      order.push('first-end');
      return 1;
    });
    const second = withSessionResetCoordination('s', async () => {
      order.push('second-start');
      return 2;
    });
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(sessionResetCoordinationLocks.size).toBe(0);
  });

  it('clears the lock map after sequential runs', async () => {
    await withSessionResetCoordination('s', async () => 'a');
    await withSessionResetCoordination('s', async () => 'b');
    expect(sessionResetCoordinationLocks.size).toBe(0);
  });

  it('throws a typed stall error when the holder never settles and is under the ceiling', async () => {
    void withSessionResetCoordination('s', () => new Promise<string>(() => {}));
    await tick();

    jest.setSystemTime(T0 + 30);
    const stalled = withSessionResetCoordination('s', async () => 'never');
    await expect(stalled).rejects.toBeInstanceOf(SessionCoordinationStallError);
    expect(sessionResetCoordinationLocks.size).toBe(1);
  });

  it('reclaims a leaked holder past the ceiling and runs the waiter', async () => {
    void withSessionResetCoordination('s', () => new Promise<string>(() => {}));
    await tick();

    jest.setSystemTime(T0 + 1_000);
    await expect(withSessionResetCoordination('s', async () => 'reclaimed')).resolves.toBe(
      'reclaimed'
    );
    expect(sessionResetCoordinationLocks.size).toBe(0);
  });

  it('does not let timed-out waiters reset the leak clock', async () => {
    void withSessionResetCoordination('s', () => new Promise<string>(() => {}));
    await tick();

    jest.setSystemTime(T0 + 30);
    await expect(withSessionResetCoordination('s', async () => 'x')).rejects.toBeInstanceOf(
      SessionCoordinationStallError
    );

    jest.setSystemTime(T0 + 45);
    await expect(withSessionResetCoordination('s', async () => 'x')).rejects.toBeInstanceOf(
      SessionCoordinationStallError
    );

    jest.setSystemTime(T0 + 61);
    await expect(withSessionResetCoordination('s', async () => 'reclaimed')).resolves.toBe(
      'reclaimed'
    );
  });

  it('rejects immediately on a pre-aborted signal without corrupting the chain', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withSessionResetCoordination('s', async () => 'x', controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(withSessionResetCoordination('s', async () => 'ok')).resolves.toBe('ok');
    expect(sessionResetCoordinationLocks.size).toBe(0);
  });

  it('aborts a registered waiter mid-wait without running it or blocking reclaim', async () => {
    void withSessionResetCoordination('s', () => new Promise<string>(() => {}));
    await tick();

    const controller = new AbortController();
    let ran = false;
    const aborted = withSessionResetCoordination(
      's',
      async () => {
        ran = true;
        return 'x';
      },
      controller.signal
    );
    await tick();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(ran).toBe(false);

    jest.setSystemTime(T0 + 1_000);
    await expect(withSessionResetCoordination('s', async () => 'reclaimed')).resolves.toBe(
      'reclaimed'
    );
    expect(sessionResetCoordinationLocks.size).toBe(0);
  });
});
