import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  acquireContextClearBoundary,
  admitAcrossContextClearBoundary,
  clearContextClearBoundariesForTest,
  getCoordinationAcquireTimeoutMs,
  getCoordinationLeakCeilingMs,
  hasContextClearBoundaryForTest,
  SessionCoordinationStallError,
  withContextClearBoundary,
} from '../../../../src/lib/agent/message-delivery';

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

describe('context-clear boundary admission', () => {
  beforeEach(() => {
    process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '20';
    clearContextClearBoundariesForTest();
  });

  afterEach(() => {
    delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
    clearContextClearBoundariesForTest();
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
    const owner = await acquireContextClearBoundary('s');
    await expect(withContextClearBoundary('s', async () => 'never')).rejects.toBeInstanceOf(
      SessionCoordinationStallError
    );

    owner.release();
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
