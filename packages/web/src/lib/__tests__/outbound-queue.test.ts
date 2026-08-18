import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@preact/signals';

const mockConnectionState = signal<'connected' | 'disconnected' | 'reconnecting'>('disconnected');

vi.mock('../state', () => ({
  connectionState: {
    get value() {
      return mockConnectionState.value;
    },
  },
  reconnectAttemptCount: { value: 0 },
}));

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: vi.fn(() => ({ request: vi.fn() })),
  },
}));

vi.mock('../toast', () => ({
  toast: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import {
  enqueueAction,
  getQueuedActions,
  cancelAction,
  clearQueue,
  flushQueue,
  resetQueue,
} from '../outbound-queue';

describe('OutboundQueue', () => {
  beforeEach(() => {
    resetQueue();
    mockConnectionState.value = 'disconnected';
    vi.clearAllMocks();
  });

  describe('enqueueAction', () => {
    it('should queue action when disconnected', async () => {
      mockConnectionState.value = 'disconnected';

      const action = await enqueueAction('Test action', async () => {});

      expect(action).toBeDefined();
      expect(action?.label).toBe('Test action');
      expect(action?.status).toBe('pending');
    });

    it('should execute immediately when connected', async () => {
      mockConnectionState.value = 'connected';
      const executed = vi.fn();

      const action = await enqueueAction('Test action', executed);

      expect(action).toBeUndefined();
      expect(executed).toHaveBeenCalledOnce();
    });

    it('should queue if execution fails due to disconnect', async () => {
      mockConnectionState.value = 'disconnected';
      const execute = vi.fn().mockRejectedValue(new Error('Connection lost'));

      const action = await enqueueAction('Test', execute);

      expect(action).toBeDefined();
      expect(action?.status).toBe('pending');
    });
  });

  describe('getQueuedActions', () => {
    it('should return all queued actions', async () => {
      await enqueueAction('Action 1', async () => {});
      await enqueueAction('Action 2', async () => {});

      const actions = getQueuedActions();
      expect(actions.length).toBe(2);
      expect(actions[0].label).toBe('Action 1');
      expect(actions[1].label).toBe('Action 2');
    });

    it('should return empty array when no actions queued', () => {
      expect(getQueuedActions().length).toBe(0);
    });
  });

  describe('cancelAction', () => {
    it('should remove action from queue', async () => {
      const action = await enqueueAction('Test', async () => {});
      expect(getQueuedActions().length).toBe(1);

      cancelAction(action!.id);
      expect(getQueuedActions().length).toBe(0);
    });

    it('should not affect other actions', async () => {
      const action1 = await enqueueAction('Action 1', async () => {});
      await enqueueAction('Action 2', async () => {});

      cancelAction(action1!.id);
      expect(getQueuedActions().length).toBe(1);
      expect(getQueuedActions()[0].label).toBe('Action 2');
    });
  });

  describe('clearQueue', () => {
    it('should remove all actions', async () => {
      await enqueueAction('Action 1', async () => {});
      await enqueueAction('Action 2', async () => {});

      clearQueue();
      expect(getQueuedActions().length).toBe(0);
    });
  });

  describe('flushQueue', () => {
    it('should execute all pending actions', async () => {
      mockConnectionState.value = 'connected';
      const executed: string[] = [];

      await enqueueAction('Action 1', async () => {
        executed.push('Action 1');
      });
      await enqueueAction('Action 2', async () => {
        executed.push('Action 2');
      });

      await flushQueue();

      expect(executed).toEqual(['Action 1', 'Action 2']);
    });

    it('should mark successful actions as sent', async () => {
      await enqueueAction('Action', async () => {});
      mockConnectionState.value = 'connected';
      await flushQueue();

      const actions = getQueuedActions();
      expect(actions[0].status).toBe('sent');
    });

    it('should mark failed actions with error', async () => {
      await enqueueAction('Failing', async () => {
        throw new Error('Network error');
      });
      mockConnectionState.value = 'connected';
      await flushQueue();

      const actions = getQueuedActions();
      expect(actions[0].status).toBe('failed');
      expect(actions[0].error).toBe('Network error');
    });

    it('should process actions sequentially', async () => {
      mockConnectionState.value = 'connected';
      const order: number[] = [];

      await enqueueAction('First', async () => {
        order.push(1);
      });
      await enqueueAction('Second', async () => {
        order.push(2);
      });

      await flushQueue();

      expect(order).toEqual([1, 2]);
    });

    it('should not flush when disconnected', async () => {
      mockConnectionState.value = 'disconnected';
      const executed = vi.fn();

      await enqueueAction('Action', executed);

      await flushQueue();

      expect(executed).not.toHaveBeenCalled();
      expect(getQueuedActions()[0].status).toBe('pending');
    });

    it('should leave remaining actions pending if connection drops mid-flush', async () => {
      let callCount = 0;
      mockConnectionState.value = 'connected';

      await enqueueAction('Action 1', async () => {
        callCount++;
      });
      await enqueueAction('Action 2', async () => {
        mockConnectionState.value = 'disconnected';
        callCount++;
      });
      await enqueueAction('Action 3', async () => {
        callCount++;
      });

      await flushQueue();

      expect(callCount).toBe(2);
      const actions = getQueuedActions();
      expect(actions.find((a) => a.label === 'Action 3')?.status).toBe('pending');
    });
  });
});
