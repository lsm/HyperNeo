/**
 * SdkStartupConcurrencyGate unit tests
 *
 * Covers the gate primitives in isolation: cap enforcement, FIFO admission,
 * the release→acquire transfer race (no double-grant), abort handling, and
 * env-var fallbacks. QueryRunner-level behaviour (release on first message,
 * startup-timeout abort, retry re-admission) lives in
 * query-runner-startup-gate*.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  DEFAULT_SDK_STARTUP_MAX_CONCURRENT,
  getSdkStartupMaxConcurrent,
  SdkStartupConcurrencyGate,
  type SdkStartupPermit,
} from '../../../../src/lib/agent/sdk-startup-gate';

describe('getSdkStartupMaxConcurrent', () => {
  const ENV_KEYS = ['HYPERNEO_SDK_STARTUP_MAX_CONCURRENT'] as const;

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('returns the default when unset or empty', () => {
    expect(getSdkStartupMaxConcurrent({})).toBe(DEFAULT_SDK_STARTUP_MAX_CONCURRENT);
    expect(getSdkStartupMaxConcurrent({ HYPERNEO_SDK_STARTUP_MAX_CONCURRENT: '' })).toBe(
      DEFAULT_SDK_STARTUP_MAX_CONCURRENT
    );
  });

  it('parses a positive integer override', () => {
    expect(getSdkStartupMaxConcurrent({ HYPERNEO_SDK_STARTUP_MAX_CONCURRENT: '5' })).toBe(5);
    expect(getSdkStartupMaxConcurrent({ HYPERNEO_SDK_STARTUP_MAX_CONCURRENT: '1' })).toBe(1);
  });

  it('falls back to the default for 0, negative, or non-numeric values', () => {
    expect(getSdkStartupMaxConcurrent({ HYPERNEO_SDK_STARTUP_MAX_CONCURRENT: '0' })).toBe(
      DEFAULT_SDK_STARTUP_MAX_CONCURRENT
    );
    expect(getSdkStartupMaxConcurrent({ HYPERNEO_SDK_STARTUP_MAX_CONCURRENT: '-2' })).toBe(
      DEFAULT_SDK_STARTUP_MAX_CONCURRENT
    );
    expect(getSdkStartupMaxConcurrent({ HYPERNEO_SDK_STARTUP_MAX_CONCURRENT: 'abc' })).toBe(
      DEFAULT_SDK_STARTUP_MAX_CONCURRENT
    );
  });
});

describe('SdkStartupConcurrencyGate', () => {
  let gate: SdkStartupConcurrencyGate;

  beforeEach(() => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '2';
    gate = new SdkStartupConcurrencyGate();
  });

  afterEach(() => {
    delete process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;
  });

  it('admits up to the cap immediately and queues the rest', async () => {
    const a = await gate.acquire({ sessionId: 'a' });
    const b = await gate.acquire({ sessionId: 'b' });
    expect(a.queuedBehind).toBe(0);
    expect(b.queuedBehind).toBe(0);

    let cGranted = false;
    const cPromise = gate.acquire({ sessionId: 'c' }).then((permit) => {
      cGranted = true;
      return permit;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cGranted).toBe(false);
    expect(gate.getStats()).toEqual({ active: 2, queued: 1, maxConcurrent: 2 });
    void cPromise;
  });

  it('admits queued waiters in FIFO order as slots free', async () => {
    const a = await gate.acquire({ sessionId: 'a' });
    await gate.acquire({ sessionId: 'b' });

    const grants: string[] = [];
    const cPromise = gate.acquire({ sessionId: 'c' }).then((p) => {
      grants.push('c');
      return p;
    });
    const dPromise = gate.acquire({ sessionId: 'd' }).then((p) => {
      grants.push('d');
      return p;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    a.release(); // frees one slot → c must be admitted before d
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(grants).toEqual(['c']);
    expect(gate.getStats()).toEqual({ active: 2, queued: 1, maxConcurrent: 2 });

    (await cPromise).release(); // → d admitted
    await dPromise;
    expect(grants).toEqual(['c', 'd']);
    expect(gate.getStats().queued).toBe(0);
  });

  it('transfers slots on release without letting a racing acquire overshoot the cap', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
    const a = await gate.acquire({ sessionId: 'a' });

    const bPromise = gate.acquire({ sessionId: 'b' });
    // acquire() runs synchronously up to the enqueue, so b is queued now.
    expect(gate.getStats()).toEqual({ active: 1, queued: 1, maxConcurrent: 1 });

    // Release and immediately race a new acquire in the same synchronous
    // block, before b's grant microtask runs. The slot must transfer to b —
    // c must NOT take a fast path through a transiently-free count.
    a.release();
    const cPromise = gate.acquire({ sessionId: 'c' });
    expect(gate.getStats()).toEqual({ active: 1, queued: 1, maxConcurrent: 1 });

    const b = await bPromise;
    expect(b.sessionId).toBe('b');
    b.release();
    const c = await cPromise;
    expect(c.sessionId).toBe('c');
    c.release();
    expect(gate.getStats()).toEqual({ active: 0, queued: 0, maxConcurrent: 1 });
  });

  it('rejects an aborted wait with AbortError and dequeues the waiter', async () => {
    const a = await gate.acquire({ sessionId: 'a' });
    await gate.acquire({ sessionId: 'b' });

    const abortController = new AbortController();
    const cPromise = gate.acquire({ sessionId: 'c', signal: abortController.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.getStats().queued).toBe(1);

    abortController.abort();
    await expect(cPromise).rejects.toThrow('SDK startup gate: admission aborted');
    const rejection = cPromise.catch((error: Error) => error).then((e) => e.name);
    await expect(rejection).resolves.toBe('AbortError');
    expect(gate.getStats()).toEqual({ active: 2, queued: 0, maxConcurrent: 2 });

    // The aborted waiter must not receive a later grant: releasing both
    // holders drains the gate to zero instead of waking c's promise.
    a.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.getStats().active).toBe(1);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();
    await expect(gate.acquire({ sessionId: 'a', signal: abortController.signal })).rejects.toThrow(
      'admission aborted'
    );
    expect(gate.getStats()).toEqual({ active: 0, queued: 0, maxConcurrent: 2 });
  });

  it('treats release() as idempotent', async () => {
    const a = await gate.acquire({ sessionId: 'a' });
    a.release();
    a.release();
    expect(gate.getStats()).toEqual({ active: 0, queued: 0, maxConcurrent: 2 });

    // A double-release must not hand the same slot to two waiters.
    await gate.acquire({ sessionId: 'b' });
    await gate.acquire({ sessionId: 'c' });
    const dPromise = gate.acquire({ sessionId: 'd' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.getStats()).toEqual({ active: 2, queued: 1, maxConcurrent: 2 });
    void dPromise;
  });

  it('reports wait metadata on the permit', async () => {
    const a = await gate.acquire({ sessionId: 'a' });
    await gate.acquire({ sessionId: 'b' });
    const cPromise = gate.acquire({ sessionId: 'c' });
    const dPromise = gate.acquire({ sessionId: 'd' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    a.release();
    const c: SdkStartupPermit = await cPromise;
    expect(c.queuedBehind).toBe(0); // first waiter: nobody ahead
    c.release();
    const d: SdkStartupPermit = await dPromise;
    expect(d.queuedBehind).toBe(1); // queued behind c
    expect(d.waitedMs).toBeGreaterThanOrEqual(0);
    expect(d.admittedAt).toBeGreaterThan(0);
    d.release();
  });
});
