// @ts-nocheck

import { StateChannel, DeltaMergers } from '../state-channel';
import type { MessageHub } from '@hyperneo/shared';

function createMockHub() {
  return {
    request: vi.fn(() => Promise.resolve(null)),
    onEvent: vi.fn(() => () => {}),
    onConnection: vi.fn(() => () => {}),
    joinRoom: vi.fn(() => {}),
    leaveRoom: vi.fn(() => {}),
  };
}

describe('StateChannel', () => {
  let mockHub: ReturnType<typeof createMockHub>;
  let channel: StateChannel<{ data: string }>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  afterEach(async () => {
    if (channel) {
      await channel.stop();
    }
  });

  describe('constructor', () => {
    it('should create with default options', () => {
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
      expect(channel).toBeDefined();
    });

    it('should create with custom options', () => {
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
        sessionId: 'test-session',
        enableDeltas: false,
        refreshInterval: 5000,
        debug: true,
        optimisticTimeout: 10000,
      });
      expect(channel).toBeDefined();
    });
  });

  describe('value and signals', () => {
    beforeEach(() => {
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    });

    it('should start with null value', () => {
      expect(channel.value).toBeNull();
    });

    it('should expose reactive signal via $', () => {
      expect(channel.$).toBeDefined();
      expect(channel.$.value).toBeNull();
    });

    it('should expose loading signal', () => {
      expect(channel.isLoading).toBeDefined();
      expect(channel.isLoading.value).toBe(false);
    });

    it('should expose error signal', () => {
      expect(channel.hasError).toBeDefined();
      expect(channel.hasError.value).toBeNull();
    });

    it('should expose lastSyncTime signal', () => {
      expect(channel.lastSyncTime).toBeDefined();
      expect(channel.lastSyncTime.value).toBe(0);
    });
  });

  describe('isStale', () => {
    beforeEach(() => {
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    });

    it('should return true when never synced', () => {
      expect(channel.isStale()).toBe(true);
    });

    it('should return true when sync time exceeds maxAge', async () => {
      const privateChannel = channel as unknown as {
        lastSync: { value: number };
      };
      privateChannel.lastSync.value = Date.now() - 120000;

      expect(channel.isStale(60000)).toBe(true);
    });

    it('should return false when sync time is within maxAge', async () => {
      const privateChannel = channel as unknown as {
        lastSync: { value: number };
      };
      privateChannel.lastSync.value = Date.now() - 30000;

      expect(channel.isStale(60000)).toBe(false);
    });

    it('should use default maxAge of 60000ms', () => {
      const privateChannel = channel as unknown as {
        lastSync: { value: number };
      };
      privateChannel.lastSync.value = Date.now() - 30000;

      expect(channel.isStale()).toBe(false);
    });
  });

  describe('start', () => {
    beforeEach(() => {
      mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));
    });

    it('should fetch initial snapshot', async () => {
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
      await channel.start();

      expect(mockHub.request).toHaveBeenCalledWith('test.channel', {});
    });

    it('should update state with snapshot', async () => {
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
      await channel.start();

      expect(channel.value).toEqual({ data: 'test' });
    });

    it('should setup subscriptions', async () => {
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
      await channel.start();

      expect(mockHub.onEvent).toHaveBeenCalled();
    });

    it('should use onEvent when option enabled', async () => {
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
        useOptimisticSubscriptions: true,
      });
      await channel.start();

      expect(mockHub.onEvent).toHaveBeenCalled();
    });

    it('should throw on fetch error', async () => {
      mockHub.request.mockImplementation(() => Promise.reject(new Error('Network error')));
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');

      await expect(channel.start()).rejects.toThrow('Network error');
    });

    it('should set error state on fetch error', async () => {
      mockHub.request.mockImplementation(() => Promise.reject(new Error('Network error')));
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');

      try {
        await channel.start();
      } catch {}

      expect(channel.hasError.value).toBeInstanceOf(Error);
      expect(channel.hasError.value?.message).toBe('Network error');
    });
  });

  describe('stop', () => {
    it('should call all unsubscribe functions', async () => {
      const unsubscribe1 = vi.fn(() => Promise.resolve());
      const unsubscribe2 = vi.fn(() => Promise.resolve());
      mockHub.onEvent.mockImplementation(() => unsubscribe1);
      mockHub.onConnection.mockImplementation(() => unsubscribe2);
      mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
      await channel.start();
      await channel.stop();

      expect(unsubscribe1).toHaveBeenCalled();
    });

    it('should clear refresh timer', async () => {
      mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
        refreshInterval: 1000,
      });
      await channel.start();

      const privateChannel = channel as unknown as {
        refreshTimer: ReturnType<typeof setInterval> | null;
      };
      expect(privateChannel.refreshTimer).not.toBeNull();

      await channel.stop();
      expect(privateChannel.refreshTimer).toBeNull();
    });
  });

  describe('refresh', () => {
    it('should fetch new snapshot', async () => {
      mockHub.request.mockImplementation(() => Promise.resolve({ data: 'initial' }));
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
      await channel.start();

      mockHub.request.mockImplementation(() => Promise.resolve({ data: 'refreshed' }));
      await channel.refresh();

      expect(channel.value).toEqual({ data: 'refreshed' });
    });
  });

  describe('updateOptimistic', () => {
    beforeEach(async () => {
      mockHub.request.mockImplementation(() => Promise.resolve({ data: 'initial' }));
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
        optimisticTimeout: 100,
      });
      await channel.start();
    });

    it('should apply optimistic update immediately', () => {
      channel.updateOptimistic('update-1', (current) => ({
        ...current,
        data: 'optimistic',
      }));
      expect(channel.value).toEqual({ data: 'optimistic' });
    });

    it('should revert on timeout', async () => {
      channel.updateOptimistic('update-1', (current) => ({
        ...current,
        data: 'optimistic',
      }));

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(channel.value).toEqual({ data: 'initial' });
    });

    it('should commit when confirmed promise resolves', async () => {
      const confirmed = Promise.resolve();
      channel.updateOptimistic(
        'update-1',
        (current) => ({ ...current, data: 'optimistic' }),
        confirmed
      );

      await confirmed;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(channel.value).toEqual({ data: 'optimistic' });
    });

    it('should revert when confirmed promise rejects', async () => {
      const confirmed = Promise.reject(new Error('Failed'));
      channel.updateOptimistic(
        'update-1',
        (current) => ({ ...current, data: 'optimistic' }),
        confirmed.catch(() => {})
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it('should no-op when state is null', () => {
      channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');

      channel.updateOptimistic('update-1', (current) => current);

      expect(channel.value).toBeNull();
    });
  });
});

describe('StateChannel - Optimistic Subscriptions', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should use onEvent when option enabled', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      useOptimisticSubscriptions: true,
    });
    await channel.start();

    expect(mockHub.onEvent).toHaveBeenCalled();

    await channel.stop();
  });

  it('should setup delta subscription when enableDeltas and mergeDelta provided', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const mergeDelta = vi.fn((current, delta) => ({ ...current, ...delta }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      enableDeltas: true,
      mergeDelta,
    });
    await channel.start();

    expect(mockHub.onEvent).toHaveBeenCalledTimes(2);
    expect(mockHub.onEvent).toHaveBeenCalledWith('test.channel', expect.any(Function));
    expect(mockHub.onEvent).toHaveBeenCalledWith('test.channel.delta', expect.any(Function));

    await channel.stop();
  });

  it('should handle delta updates by calling mergeDelta', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ count: 0 }));

    let deltaHandler: ((delta: unknown) => void) | null = null;
    mockHub.onEvent.mockImplementation((channel, handler) => {
      if (channel.includes('.delta')) {
        deltaHandler = handler;
      }
      return () => {};
    });

    const mergeDelta = vi.fn((current: { count: number }, delta: { increment: number }) => ({
      count: current.count + delta.increment,
    }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      enableDeltas: true,
      mergeDelta,
    });
    await channel.start();

    expect(deltaHandler).not.toBeNull();
    if (deltaHandler) {
      deltaHandler({ increment: 5 });
    }

    expect(mergeDelta).toHaveBeenCalledWith({ count: 0 }, { increment: 5 });
    expect(channel.value).toEqual({ count: 5 });

    await channel.stop();
  });

  it('should skip delta when state is null', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve(null));

    let deltaHandler: ((delta: unknown) => void) | null = null;
    mockHub.onEvent.mockImplementation((channel, handler) => {
      if (channel.includes('.delta')) {
        deltaHandler = handler;
      }
      return () => {};
    });

    const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      enableDeltas: true,
      mergeDelta: mergeFn,
    });
    await channel.start();

    if (deltaHandler) {
      deltaHandler({ increment: 5 });
    }

    expect(mergeFn).not.toHaveBeenCalled();

    await channel.stop();
  });
});

describe('StateChannel - Non-Blocking Mode', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should setup subscriptions in background when nonBlocking is true', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      nonBlocking: true,
    });

    await channel.start();

    expect(channel.value).toEqual({ data: 'test' });

    await channel.stop();
  });
});

describe('StateChannel - Reconnection Handling', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should setup reconnection handler on start', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    await channel.start();

    expect(mockHub.onConnection).toHaveBeenCalled();

    await channel.stop();
  });

  it('should refresh state on reconnection', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'initial' }));

    let connectionHandler: ((state: string) => void) | null = null;
    mockHub.onConnection.mockImplementation((handler) => {
      connectionHandler = handler;
      return () => {};
    });

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    await channel.start();

    expect(channel.value).toEqual({ data: 'initial' });

    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'reconnected' }));

    if (connectionHandler) {
      connectionHandler('connected');
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(channel.value).toEqual({ data: 'reconnected' });

    await channel.stop();
  });

  it('should set error on disconnection', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    let connectionHandler: ((state: string) => void) | null = null;
    mockHub.onConnection.mockImplementation((handler) => {
      connectionHandler = handler;
      return () => {};
    });

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    await channel.start();

    if (connectionHandler) {
      connectionHandler('disconnected');
    }

    expect(channel.hasError.value).toBeInstanceOf(Error);
    expect(channel.hasError.value?.message).toContain('disconnected');

    await channel.stop();
  });

  it('should set error on connection error', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    let connectionHandler: ((state: string) => void) | null = null;
    mockHub.onConnection.mockImplementation((handler) => {
      connectionHandler = handler;
      return () => {};
    });

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    await channel.start();

    if (connectionHandler) {
      connectionHandler('error');
    }

    expect(channel.hasError.value).toBeInstanceOf(Error);
    expect(channel.hasError.value?.message).toContain('error');

    await channel.stop();
  });
});

describe('StateChannel - Auto Refresh', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should not setup auto-refresh when refreshInterval is 0', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      refreshInterval: 0,
    });
    await channel.start();

    expect(mockHub.request).toHaveBeenCalledTimes(1);

    await channel.stop();
  });

  it('should clear auto-refresh timer on stop', async () => {
    vi.useFakeTimers();
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      refreshInterval: 1000,
    });
    await channel.start();

    await channel.stop();

    const callCountAfterStop = mockHub.request.mock.calls.length;

    vi.advanceTimersByTime(5000);

    expect(mockHub.request).toHaveBeenCalledTimes(callCountAfterStop);
    vi.useRealTimers();
  });

  it('should detect stale state correctly', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    await channel.start();

    expect(channel.isStale(60000)).toBe(false);

    await channel.stop();
  });

  it('should report stale when maxAge exceeded', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test', timestamp: 1000 }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    await channel.start();

    expect(channel.isStale(0)).toBe(true);

    await channel.stop();
  });
});

describe('StateChannel - Reconnection Replaces State', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should replace state with new snapshot on reconnection', async () => {
    const initialMessages = [
      { uuid: '1', timestamp: 100, content: 'msg1' },
      { uuid: '2', timestamp: 200, content: 'msg2' },
    ];

    mockHub.request.mockImplementation(() => Promise.resolve({ sdkMessages: initialMessages }));

    let connectionHandler: ((state: string) => void) | null = null;
    mockHub.onConnection.mockImplementation((handler) => {
      connectionHandler = handler;
      return () => {};
    });

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    await channel.start();

    const initialResult = channel.value as { sdkMessages: Array<Record<string, unknown>> };
    expect(initialResult.sdkMessages).toHaveLength(2);

    const reconnectMessages = [
      { uuid: '2', timestamp: 200, content: 'msg2-updated' },
      { uuid: '3', timestamp: 300, content: 'msg3' },
    ];

    mockHub.request.mockImplementation(() => Promise.resolve({ sdkMessages: reconnectMessages }));

    if (connectionHandler) {
      connectionHandler('connected');
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = channel.value as { sdkMessages: Array<Record<string, unknown>> };
    expect(result.sdkMessages).toHaveLength(2);
    expect(result.sdkMessages.map((m) => m.uuid)).toEqual(['2', '3']);

    await channel.stop();
  });
});

describe('StateChannel - Session-scoped Channels', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should include sessionId in call data for non-global channels', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      sessionId: 'session-123',
    });
    await channel.start();

    expect(mockHub.request).toHaveBeenCalledWith('test.channel', { sessionId: 'session-123' });

    await channel.stop();
  });

  it('should not include sessionId in call data for global channels', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      sessionId: 'global',
    });
    await channel.start();

    expect(mockHub.request).toHaveBeenCalledWith('test.channel', {});

    await channel.stop();
  });
});

describe('StateChannel - Non-Blocking Subscription Errors', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should handle non-blocking mode gracefully', async () => {
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      nonBlocking: true,
    });

    await channel.start();

    await channel.stop();
  });
});

describe('StateChannel - Incremental Sync', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should merge SDK messages when fetching with since parameter', async () => {
    mockHub.request.mockImplementationOnce(() =>
      Promise.resolve({
        sdkMessages: [
          { uuid: 'msg-1', content: 'First', timestamp: 100 },
          { uuid: 'msg-2', content: 'Second', timestamp: 200 },
        ],
      })
    );

    const channel = new StateChannel<{
      sdkMessages: Array<{ uuid: string; content: string; timestamp: number }>;
    }>(mockHub as unknown as MessageHub, 'test.channel');

    await channel.start();

    mockHub.request.mockImplementationOnce(() =>
      Promise.resolve({
        sdkMessages: [
          { uuid: 'msg-2', content: 'Second Updated', timestamp: 200 },
          { uuid: 'msg-3', content: 'Third', timestamp: 300 },
        ],
      })
    );

    const privateChannel = channel as unknown as {
      fetchSnapshot: (since?: number) => Promise<void>;
    };
    await privateChannel.fetchSnapshot(100);

    const result = channel.value?.sdkMessages;
    expect(result).toHaveLength(3);
    expect(result?.[0].uuid).toBe('msg-1');
    expect(result?.[1].uuid).toBe('msg-2');
    expect(result?.[2].uuid).toBe('msg-3');

    await channel.stop();
  });

  it('should handle messages without uuid in merge', async () => {
    mockHub.request.mockImplementationOnce(() =>
      Promise.resolve({
        sdkMessages: [{ content: 'No UUID 1', timestamp: 100 }],
      })
    );

    const channel = new StateChannel<{
      sdkMessages: Array<{ uuid?: string; content: string; timestamp: number }>;
    }>(mockHub as unknown as MessageHub, 'test.channel');

    await channel.start();

    mockHub.request.mockImplementationOnce(() =>
      Promise.resolve({
        sdkMessages: [{ content: 'No UUID 2', timestamp: 200 }],
      })
    );

    const privateChannel = channel as unknown as {
      fetchSnapshot: (since?: number) => Promise<void>;
    };
    await privateChannel.fetchSnapshot(100);

    await channel.stop();
  });
});

describe('StateChannel - Full Subscription Callbacks', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should update state when full update received via onEvent subscription', async () => {
    let fullUpdateCallback: ((data: unknown) => void) | null = null;
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'initial' }));
    mockHub.onEvent.mockImplementation((_channel: string, callback: unknown) => {
      if (!_channel.includes('.delta')) {
        fullUpdateCallback = callback as (data: unknown) => void;
      }
      return () => {};
    });

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel');
    await channel.start();

    expect(fullUpdateCallback).not.toBeNull();

    fullUpdateCallback?.({ data: 'updated' });

    expect(channel.value).toEqual({ data: 'updated' });
    expect(channel.lastSyncTime.value).toBeGreaterThan(0);
    expect(channel.hasError.value).toBeNull();

    await channel.stop();
  });

  it('should apply delta via onEvent subscription when state exists', async () => {
    let deltaCallback: ((data: unknown) => void) | null = null;
    mockHub.request.mockImplementation(() => Promise.resolve({ count: 0 }));
    mockHub.onEvent.mockImplementation((channelName: string, callback: unknown) => {
      if (channelName.includes('.delta')) {
        deltaCallback = callback as (data: unknown) => void;
      }
      return () => {};
    });

    const mergeFn = vi.fn((current: { count: number }, delta: { increment: number }) => ({
      count: current.count + delta.increment,
    }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      enableDeltas: true,
      mergeDelta: mergeFn,
    });
    await channel.start();

    expect(deltaCallback).not.toBeNull();

    deltaCallback?.({ increment: 5 });

    expect(mergeFn).toHaveBeenCalledWith({ count: 0 }, { increment: 5 });
    expect(channel.value).toEqual({ count: 5 });

    await channel.stop();
  });

  it('should skip delta via onEvent subscription when state is null', async () => {
    let deltaCallback: ((data: unknown) => void) | null = null;
    mockHub.request.mockImplementation(() => Promise.resolve(null));
    mockHub.onEvent.mockImplementation((channelName: string, callback: unknown) => {
      if (channelName.includes('.delta')) {
        deltaCallback = callback as (data: unknown) => void;
      }
      return () => {};
    });

    const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      enableDeltas: true,
      mergeDelta: mergeFn,
    });
    await channel.start();

    deltaCallback?.({ increment: 5 });

    expect(mergeFn).not.toHaveBeenCalled();

    await channel.stop();
  });
});

describe('StateChannel - Optimistic Subscription Full Update', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should update state when full update received via optimistic subscription', async () => {
    let fullUpdateCallback: ((data: unknown) => void) | null = null;
    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'initial' }));
    mockHub.onEvent.mockImplementation((_channel: string, callback: unknown) => {
      if (!_channel.includes('.delta')) {
        fullUpdateCallback = callback as (data: unknown) => void;
      }
      return () => {};
    });

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      useOptimisticSubscriptions: true,
    });
    await channel.start();

    expect(fullUpdateCallback).not.toBeNull();

    fullUpdateCallback?.({ data: 'optimistic-updated' });

    expect(channel.value).toEqual({ data: 'optimistic-updated' });
    expect(channel.lastSyncTime.value).toBeGreaterThan(0);
    expect(channel.hasError.value).toBeNull();

    await channel.stop();
  });

  it('should apply delta via optimistic subscription when state exists', async () => {
    let deltaCallback: ((data: unknown) => void) | null = null;
    mockHub.request.mockImplementation(() => Promise.resolve({ count: 10 }));
    mockHub.onEvent.mockImplementation((channelName: string, callback: unknown) => {
      if (channelName.includes('.delta')) {
        deltaCallback = callback as (data: unknown) => void;
      }
      return () => {};
    });

    const mergeFn = vi.fn((current: { count: number }, delta: { increment: number }) => ({
      count: current.count + delta.increment,
    }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      useOptimisticSubscriptions: true,
      enableDeltas: true,
      mergeDelta: mergeFn,
    });
    await channel.start();

    expect(deltaCallback).not.toBeNull();

    deltaCallback?.({ increment: 3 });

    expect(mergeFn).toHaveBeenCalledWith({ count: 10 }, { increment: 3 });
    expect(channel.value).toEqual({ count: 13 });

    await channel.stop();
  });

  it('should skip delta via optimistic subscription when state is null', async () => {
    let deltaCallback: ((data: unknown) => void) | null = null;
    mockHub.request.mockImplementation(() => Promise.resolve(null));
    mockHub.onEvent.mockImplementation((channelName: string, callback: unknown) => {
      if (channelName.includes('.delta')) {
        deltaCallback = callback as (data: unknown) => void;
      }
      return () => {};
    });

    const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      useOptimisticSubscriptions: true,
      enableDeltas: true,
      mergeDelta: mergeFn,
    });
    await channel.start();

    deltaCallback?.({ increment: 5 });

    expect(mergeFn).not.toHaveBeenCalled();

    await channel.stop();
  });
});

describe('StateChannel - Auto-Refresh Trigger', () => {
  let mockHub: ReturnType<typeof createMockHub>;

  beforeEach(() => {
    mockHub = createMockHub();
  });

  it('should auto-refresh when stale', async () => {
    vi.useFakeTimers();

    mockHub.request.mockImplementation(() => Promise.resolve({ data: 'test' }));

    const channel = new StateChannel(mockHub as unknown as MessageHub, 'test.channel', {
      refreshInterval: 1000,
    });
    await channel.start();

    expect(mockHub.request).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);

    expect(mockHub.request.mock.calls.length).toBeGreaterThan(1);

    await channel.stop();
    vi.useRealTimers();
  });
});

describe('DeltaMergers', () => {
  describe('array', () => {
    interface Item {
      id: string;
      name: string;
    }

    it('should add new items to start of array', () => {
      const current: Item[] = [{ id: '1', name: 'One' }];
      const delta = { added: [{ id: '2', name: 'Two' }] };

      const result = DeltaMergers.array(current, delta);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('2');
      expect(result[1].id).toBe('1');
    });

    it('should remove items by id', () => {
      const current: Item[] = [
        { id: '1', name: 'One' },
        { id: '2', name: 'Two' },
        { id: '3', name: 'Three' },
      ];
      const delta = { removed: ['2'] };

      const result = DeltaMergers.array(current, delta);

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id)).toEqual(['1', '3']);
    });

    it('should update existing items', () => {
      const current: Item[] = [
        { id: '1', name: 'One' },
        { id: '2', name: 'Two' },
      ];
      const delta = { updated: [{ id: '2', name: 'Updated Two' }] };

      const result = DeltaMergers.array(current, delta);

      expect(result).toHaveLength(2);
      expect(result[1].name).toBe('Updated Two');
    });

    it('should handle combined operations in correct order', () => {
      const current: Item[] = [
        { id: '1', name: 'One' },
        { id: '2', name: 'Two' },
      ];
      const delta = {
        added: [{ id: '3', name: 'Three' }],
        updated: [{ id: '1', name: 'Updated One' }],
        removed: ['2'],
      };

      const result = DeltaMergers.array(current, delta);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('3');
      expect(result[1].name).toBe('Updated One');
    });

    it('should handle empty delta', () => {
      const current: Item[] = [{ id: '1', name: 'One' }];
      const delta = {};

      const result = DeltaMergers.array(current, delta);

      expect(result).toEqual(current);
    });

    it('should handle non-existent update gracefully', () => {
      const current: Item[] = [{ id: '1', name: 'One' }];
      const delta = { updated: [{ id: 'nonexistent', name: 'Ghost' }] };

      const result = DeltaMergers.array(current, delta);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: '1', name: 'One' });
    });
  });

  describe('object', () => {
    it('should merge object properties', () => {
      const current = { a: 1, b: 2, c: 3 };
      const delta = { b: 20, d: 4 };

      const result = DeltaMergers.object(current, delta);

      expect(result).toEqual({ a: 1, b: 20, c: 3, d: 4 });
    });

    it('should handle empty delta', () => {
      const current = { a: 1, b: 2 };
      const delta = {};

      const result = DeltaMergers.object(current, delta);

      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('should handle nested objects (shallow merge)', () => {
      const current = { nested: { a: 1, b: 2 }, other: 'value' };
      const delta = { nested: { c: 3 } };

      const result = DeltaMergers.object(current, delta);

      expect(result).toEqual({ nested: { c: 3 }, other: 'value' });
    });
  });

  describe('append', () => {
    it('should append added items to end of array', () => {
      const current = [1, 2, 3];
      const delta = { added: [4, 5] };

      const result = DeltaMergers.append(current, delta);

      expect(result).toEqual([1, 2, 3, 4, 5]);
    });

    it('should return current array when no added items', () => {
      const current = [1, 2, 3];
      const delta = {};

      const result = DeltaMergers.append(current, delta);

      expect(result).toBe(current);
    });

    it('should handle empty added array', () => {
      const current = [1, 2, 3];
      const delta = { added: [] };

      const result = DeltaMergers.append(current, delta);

      expect(result).toEqual([1, 2, 3]);
    });

    it('should work with objects', () => {
      const current = [{ id: 1 }, { id: 2 }];
      const delta = { added: [{ id: 3 }] };

      const result = DeltaMergers.append(current, delta);

      expect(result).toHaveLength(3);
      expect(result[2]).toEqual({ id: 3 });
    });
  });
});
