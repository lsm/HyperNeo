import { describe, expect, it } from 'bun:test';
import { ProviderEnvCoordinator } from '../../../../src/lib/providers/provider-env-coordinator';

const OWNER = 'query-runner';
const READER = 'anthropic.isAvailable';

function newCoordinator(): ProviderEnvCoordinator {
  const c = new ProviderEnvCoordinator();
  c.registerOwner(OWNER);
  c.registerReader(READER);
  return c;
}

async function settledWithinTurns(flag: () => boolean): Promise<boolean> {
  await Bun.sleep(1);
  return flag();
}

describe('ProviderEnvCoordinator registry', () => {
  it('records roles and rejects duplicate or unenrolled names', async () => {
    const c = newCoordinator();
    expect(c.roleOf(OWNER)).toBe('owner');
    expect(c.roleOf(READER)).toBe('reader');
    expect(c.roleOf('stranger')).toBeNull();
    expect(() => c.registerOwner(OWNER)).toThrow('already enrolled');
    expect(() => c.registerReader(OWNER)).toThrow('already enrolled');
    await expect(c.acquire('stranger')).rejects.toThrow('not enrolled');
  });
});

describe('ProviderEnvCoordinator lease', () => {
  it('grants an exclusive lease, frees it on release, and rejects foreign tokens', async () => {
    const c = newCoordinator();
    const token = await c.acquire(OWNER);
    expect(c.isLeaseHeld()).toBe(true);
    expect(c.activeHolder()).toEqual({ id: token.id, enrolledAs: OWNER });
    const foreign = await newCoordinator().acquire(OWNER);
    expect(() => c.release(foreign)).toThrow('non-holder');
    await expect(c.acquire(READER, c.activeHolder())).rejects.toThrow('stale lease token');
    c.release(token);
    expect(c.isLeaseHeld()).toBe(false);
    expect(c.activeHolder()).toBeNull();
  });

  it('queues a second acquirer until the holder releases, FIFO across waiters', async () => {
    const c = newCoordinator();
    const first = await c.acquire(OWNER);
    const order: string[] = [];
    const second = c.acquire(READER).then((t) => {
      order.push('reader');
      return t;
    });
    const third = c.acquire(OWNER).then((t) => {
      order.push('owner');
      return t;
    });
    expect(await settledWithinTurns(() => order.length > 0)).toBe(false);
    c.release(first);
    const secondToken = await second;
    expect(order).toEqual(['reader']);
    c.release(secondToken);
    c.release(await third);
    expect(order).toEqual(['reader', 'owner']);
    expect(c.isLeaseHeld()).toBe(false);
  });

  it('releases the lease when runWithLease body throws', async () => {
    const c = newCoordinator();
    await expect(
      c.runWithLease(OWNER, () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(c.isLeaseHeld()).toBe(false);
    const token = await c.acquire(READER);
    c.release(token);
  });
});

describe('ProviderEnvCoordinator reentrancy', () => {
  it('lets a holder re-enter through an enrolled reader without deadlock', async () => {
    const c = newCoordinator();
    const result = await c.runWithLease(OWNER, async (outer) => {
      const inner = await c.runWithLease(READER, (nested) => nested);
      expect(inner).toBe(outer);
      return inner;
    });
    expect(c.isLeaseHeld()).toBe(false);
    expect(result.enrolledAs).toBe(OWNER);
  });

  it('keeps the lease held until the outermost release', async () => {
    const c = newCoordinator();
    const outer = await c.acquire(OWNER);
    const nested = await c.acquire(READER, outer);
    c.release(nested);
    expect(c.isLeaseHeld()).toBe(true);
    let waiterAcquired = false;
    const waiter = c.acquire(READER).then((t) => {
      waiterAcquired = true;
      return t;
    });
    expect(await settledWithinTurns(() => waiterAcquired)).toBe(false);
    c.release(outer);
    c.release(await waiter);
    expect(waiterAcquired).toBe(true);
    expect(c.isLeaseHeld()).toBe(false);
  });

  it('propagates an explicitly passed holder token into a read', async () => {
    const c = newCoordinator();
    const token = await c.acquire(OWNER);
    const propagated = await c.acquire(READER, token);
    expect(propagated).toBe(token);
    c.release(propagated);
    expect(c.isLeaseHeld()).toBe(true);
    c.release(token);
    expect(c.isLeaseHeld()).toBe(false);
  });

  it('rejects acquisition carrying a stale token', async () => {
    const c = newCoordinator();
    const token = await c.acquire(OWNER);
    c.release(token);
    await expect(c.acquire(READER, token)).rejects.toThrow('stale lease token');
    expect(() => c.release(token)).toThrow('non-holder');
  });

  it('rejects ambient re-entry with a token held past release', async () => {
    const c = newCoordinator();
    let leaked: Promise<unknown> | undefined;
    await c.runWithLease(OWNER, () => {
      leaked = (async () => {
        await Bun.sleep(1);
        return c.acquire(READER);
      })();
    });
    const replacement = await c.acquire(OWNER);
    await expect(leaked!).rejects.toThrow('stale lease token');
    c.release(replacement);
  });
});
