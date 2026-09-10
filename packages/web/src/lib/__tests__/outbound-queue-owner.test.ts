import { effect, signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutboundQueue } from '../outbound-queue-owner';

function fixture() {
  const connected = signal(false);
  const warn = vi.fn();
  const queue = createOutboundQueue({
    isConnected: () => connected.value,
    observeConnection: effect,
    warn,
  });
  return { connected, warn, queue };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('outbound queue owner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps queue contents, cancellation and IDs independent', async () => {
    const a = fixture();
    const b = fixture();
    const first = await a.queue.enqueueAction('a', async () => {});
    const second = await b.queue.enqueueAction('b', async () => {});
    expect(first?.id).toBe('queue-1');
    expect(second?.id).toBe('queue-1');
    a.queue.cancelAction(first!.id);
    a.queue.resetQueue();
    expect(a.queue.getQueuedActions()).toEqual([]);
    expect(b.queue.getQueuedActions()).toEqual([second]);
  });

  it('keeps flush locks independent while preserving per-queue serialization', async () => {
    const a = fixture();
    const b = fixture();
    const gate = deferred();
    const first = vi.fn(() => gate.promise);
    const next = vi.fn(async () => {});
    const remote = vi.fn(async () => {});
    await a.queue.enqueueAction('first', first);
    await a.queue.enqueueAction('next', next);
    await b.queue.enqueueAction('remote', remote);
    a.connected.value = b.connected.value = true;
    const pending = a.queue.flushQueue();
    await a.queue.flushQueue();
    await b.queue.flushQueue();
    expect(first).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(remote).toHaveBeenCalledTimes(1);
    gate.resolve();
    await pending;
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('observes only its own connection and can stop and restart observation', async () => {
    const a = fixture();
    const b = fixture();
    const runA = vi.fn(async () => {});
    const runB = vi.fn(async () => {});
    await a.queue.enqueueAction('a', runA);
    await b.queue.enqueueAction('b', runB);
    a.queue.startAutoFlush();
    a.queue.startAutoFlush();
    b.queue.startAutoFlush();
    try {
      a.connected.value = true;
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(runA).toHaveBeenCalledTimes(1);
      expect(runB).not.toHaveBeenCalled();
      b.queue.stopAutoFlush();
      b.connected.value = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(runB).not.toHaveBeenCalled();
      b.queue.startAutoFlush();
      await vi.advanceTimersByTimeAsync(500);
      expect(runB).toHaveBeenCalledTimes(1);
    } finally {
      a.queue.stopAutoFlush();
      b.queue.stopAutoFlush();
    }
  });

  it.each(['immediate', 'queued'])('retries %s execution after connection loss', async (mode) => {
    const { queue, connected, warn } = fixture();
    const gate = deferred();
    const execute = vi.fn(() => gate.promise);
    connected.value = mode === 'immediate';
    const admitted = queue.enqueueAction('send', execute);
    if (mode === 'queued') await admitted;
    connected.value = true;
    const pending = mode === 'queued' ? queue.flushQueue() : admitted;
    connected.value = false;
    gate.reject(new Error('lost connection'));
    await pending;
    expect(queue.getQueuedActions()[0].status).toBe('pending');
    expect(warn).not.toHaveBeenCalled();
    execute.mockResolvedValue(undefined);
    connected.value = true;
    await queue.flushQueue();
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(queue.getQueuedActions()).toEqual([]);
  });

  it('retains connected failures and warns only through its own dependency', async () => {
    const a = fixture();
    const b = fixture();
    await a.queue.enqueueAction('fail', async () => {
      throw new Error('Request refused');
    });
    a.connected.value = true;
    await a.queue.flushQueue();
    expect(a.queue.getQueuedActions()[0]).toMatchObject({
      status: 'failed',
      error: 'Request refused',
    });
    expect(a.warn).toHaveBeenCalledWith('1 action(s) could not be delivered.');
    expect(b.warn).not.toHaveBeenCalled();
  });
});
