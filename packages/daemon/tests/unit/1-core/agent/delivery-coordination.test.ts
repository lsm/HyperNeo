import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import {
  acquireContextClearBoundary,
  admitAcrossContextClearBoundary,
  clearContextClearBoundariesForTest,
  hasContextClearBoundaryForTest,
  getCoordinationAcquireTimeoutMs,
  getCoordinationLeakCeilingMs,
  SessionCoordinationStallError,
  sessionResetCoordinationLocks,
  withContextClearBoundary,
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

  it('bails out of reclaim when a successor registered after the timed-out waiter', async () => {
    void withSessionResetCoordination('s', () => new Promise<string>(() => {}));
    await tick();

    const first = withSessionResetCoordination('s', async () => 'first');
    const second = withSessionResetCoordination('s', async () => 'second');
    jest.setSystemTime(T0 + 1_000);
    await expect(first).rejects.toBeInstanceOf(SessionCoordinationStallError);
    await expect(second).resolves.toBe('second');
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

describe('context-clear boundary admission', () => {
  beforeEach(() => {
    process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '20';
    sessionResetCoordinationLocks.clear();
    clearContextClearBoundariesForTest();
  });

  afterEach(() => {
    delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
    sessionResetCoordinationLocks.clear();
    clearContextClearBoundariesForTest();
  });

  it('admits without waiting behind a reset-coordination holder', async () => {
    void withSessionResetCoordination('s', () => new Promise<string>(() => {}));
    await tick();

    await expect(
      admitAcrossContextClearBoundary('s', undefined, async () => 'delivered')
    ).resolves.toEqual({ kind: 'admitted', result: 'delivered' });
  });

  it('admissions behind a held boundary run in registration order', async () => {
    const order: string[] = [];
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withContextClearBoundary('s', () => holderGate);
    const first = admitAcrossContextClearBoundary('s', undefined, async () => {
      order.push('first-start');
      await tick();
      order.push('first-end');
      return 1;
    });
    const second = admitAcrossContextClearBoundary('s', undefined, async () => {
      order.push('second-start');
      return 2;
    });
    await tick();
    expect(order).toEqual([]);

    releaseHolder();
    await holder;
    await expect(first).resolves.toEqual({ kind: 'admitted', result: 1 });
    await expect(second).resolves.toEqual({ kind: 'admitted', result: 2 });
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('an admission holds the boundary through its admit section', async () => {
    let releaseAdmit!: () => void;
    const admitGate = new Promise<void>((resolve) => {
      releaseAdmit = resolve;
    });
    const admission = admitAcrossContextClearBoundary('s', undefined, () =>
      admitGate.then(() => 'done')
    );
    await tick();

    await expect(withContextClearBoundary('s', async () => 'never')).rejects.toBeInstanceOf(
      SessionCoordinationStallError
    );

    releaseAdmit();
    await expect(admission).resolves.toEqual({ kind: 'admitted', result: 'done' });
    await expect(withContextClearBoundary('s', async () => 'ok')).resolves.toBe('ok');
  });

  it('a stalled admission reports boundary_wait and abandons without blocking successors', async () => {
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withContextClearBoundary('s', () => holderGate);
    await tick();

    await expect(admitAcrossContextClearBoundary('s', undefined, async () => 'x')).resolves.toEqual(
      { kind: 'boundary_wait' }
    );

    const successor = withContextClearBoundary('s', async () => 'ok-after-holder');
    releaseHolder();
    await holder;
    await expect(successor).resolves.toBe('ok-after-holder');
  });

  it('rejects immediately on a pre-aborted signal without corrupting the chain', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      admitAcrossContextClearBoundary('s', controller.signal, async () => 'x')
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(withContextClearBoundary('s', async () => 'ok')).resolves.toBe('ok');
  });

  it('acquireContextClearBoundary holds the slot until its release runs', async () => {
    const release = await acquireContextClearBoundary('s');
    await expect(withContextClearBoundary('s', async () => 'never')).rejects.toBeInstanceOf(
      SessionCoordinationStallError
    );

    release();
    await expect(withContextClearBoundary('s', async () => 'ok')).resolves.toBe('ok');
  });

  it('a timed-out waiter does not unlock the boundary for later arrivals', async () => {
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withContextClearBoundary('s', () => holderGate);
    await tick();

    await expect(admitAcrossContextClearBoundary('s', undefined, async () => 'x')).resolves.toEqual(
      { kind: 'boundary_wait' }
    );

    let newcomerRan = false;
    const newcomer = withContextClearBoundary('s', async () => {
      newcomerRan = true;
      return 'newcomer-ok';
    });
    let newcomerStalled = false;
    const newcomerSettled = newcomer.catch((error) => {
      newcomerStalled = error instanceof SessionCoordinationStallError;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(newcomerRan).toBe(false);
    await newcomerSettled;
    expect(newcomerStalled).toBe(true);

    releaseHolder();
    await holder;
    await expect(withContextClearBoundary('s', async () => 'after-ok')).resolves.toBe('after-ok');
  });

  it('an abandoned boundary entry cleans itself up once the real holder settles', async () => {
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withContextClearBoundary('s', () => holderGate);
    await tick();

    await expect(admitAcrossContextClearBoundary('s', undefined, async () => 'x')).resolves.toEqual(
      { kind: 'boundary_wait' }
    );
    expect(hasContextClearBoundaryForTest('s')).toBe(true);

    releaseHolder();
    await holder;
    await tick();
    expect(hasContextClearBoundaryForTest('s')).toBe(false);
  });

  it('acquireContextClearBoundary stalls behind a holder and abandons without blocking successors', async () => {
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withContextClearBoundary('s', () => holderGate);
    await tick();

    await expect(acquireContextClearBoundary('s')).rejects.toBeInstanceOf(
      SessionCoordinationStallError
    );

    releaseHolder();
    await holder;
    await expect(withContextClearBoundary('s', async () => 'ok-after-holder')).resolves.toBe(
      'ok-after-holder'
    );
  });
});
