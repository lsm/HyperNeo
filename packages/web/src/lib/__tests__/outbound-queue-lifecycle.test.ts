import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueAction,
  flushQueue,
  getQueuedActions,
  resetQueue,
  startAutoFlush,
  stopAutoFlush,
} from '../outbound-queue';

const connected = signal('disconnected');
vi.mock('../state', () => ({
  connectionState: {
    get value() {
      return connected.value;
    },
  },
}));
vi.mock('../toast', () => ({ toast: { warning: vi.fn() } }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('outbound queue lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopAutoFlush();
    resetQueue();
    connected.value = 'disconnected';
  });
  afterEach(() => {
    stopAutoFlush();
    resetQueue();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('queues the original action when an immediate execution loses connection', async () => {
    connected.value = 'connected';
    const gate = deferred();
    const execute = vi.fn(() => gate.promise);
    const pending = enqueueAction('send', execute);
    expect(execute).toHaveBeenCalledTimes(1);
    connected.value = 'disconnected';
    gate.reject(new Error('connection lost'));
    const action = await pending;
    expect(action).toMatchObject({ label: 'send', status: 'pending', execute });
    expect(getQueuedActions()).toEqual([action]);
    execute.mockResolvedValue(undefined);
    connected.value = 'connected';
    await flushQueue();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(action?.status).toBe('sent');
  });

  it('propagates an immediate failure while connected without enqueuing', async () => {
    connected.value = 'connected';
    const failure = new Error('request refused');
    await expect(
      enqueueAction('send', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(getQueuedActions()).toEqual([]);
  });

  it('serializes pending actions and ignores overlapping flushes', async () => {
    const gate = deferred();
    const first = vi.fn(() => gate.promise);
    const second = vi.fn(async () => {});
    await enqueueAction('first', first);
    await enqueueAction('second', second);
    connected.value = 'connected';
    const pending = flushQueue();
    await flushQueue();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    gate.resolve();
    await pending;
    expect(second).toHaveBeenCalledTimes(1);
    expect(getQueuedActions().map((action) => action.status)).toEqual(['sent', 'sent']);
  });

  it('retains a failed in-flight action for retry when disconnected', async () => {
    const gate = deferred();
    const execute = vi.fn(() => gate.promise);
    const first = await enqueueAction('first', execute);
    const second = vi.fn(async () => {});
    await enqueueAction('second', second);
    connected.value = 'connected';
    const pending = flushQueue();
    connected.value = 'disconnected';
    gate.reject(new Error('connection lost'));
    await pending;
    expect(first?.status).toBe('pending');
    expect(first?.error).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
    execute.mockResolvedValue(undefined);
    connected.value = 'connected';
    await flushQueue();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('starts auto-flush once and stops scheduling on subsequent connection changes', async () => {
    const execute = vi.fn(async () => {});
    await enqueueAction('send', execute);
    startAutoFlush();
    startAutoFlush();
    connected.value = 'connected';
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(getQueuedActions()).toEqual([]);
    stopAutoFlush();
    connected.value = 'disconnected';
    await enqueueAction('later', execute);
    connected.value = 'connected';
    await vi.advanceTimersByTimeAsync(500);
    expect(execute).toHaveBeenCalledTimes(1);
    startAutoFlush();
    await vi.advanceTimersByTimeAsync(500);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
