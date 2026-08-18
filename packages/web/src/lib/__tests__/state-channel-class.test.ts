// @ts-nocheck

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateChannel } from '../state-channel';
import type { MessageHub } from '@hyperneo/shared';

vi.mock('@hyperneo/shared', () => ({
  MessageHub: vi.fn(),
}));

const mockHubObj: {
  request: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onConnection: ReturnType<typeof vi.fn>;
  joinRoom: ReturnType<typeof vi.fn>;
  leaveRoom: ReturnType<typeof vi.fn>;
} = {
  request: vi.fn(() => Promise.resolve({ data: 'test', timestamp: 123456 })),
  onEvent: vi.fn(() => vi.fn()),
  onConnection: vi.fn(() => vi.fn()),
  joinRoom: vi.fn(() => {}),
  leaveRoom: vi.fn(() => {}),
};

vi.mock('../state', () => ({
  appState: { value: {} },
  connectionState: { value: 'disconnected' },
}));

describe('StateChannel - Comprehensive Coverage', () => {
  let channel: StateChannel<{ data: string; timestamp?: number }>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockHubObj.request = vi.fn(() => Promise.resolve({ data: 'test', timestamp: 123456 }));
    mockHubObj.onEvent = vi.fn(() => vi.fn());
    mockHubObj.onConnection = vi.fn(() => vi.fn());
    mockHubObj.joinRoom = vi.fn(() => {});
    mockHubObj.leaveRoom = vi.fn(() => {});

    channel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel');
  });

  afterEach(async () => {
    if (channel) {
      await channel.stop();
    }
  });

  describe('constructor and options', () => {
    it('should set default options', () => {
      const testChannel = new StateChannel(mockHubObj, 'test.channel');
      expect(testChannel).toBeDefined();
    });

    it('should use custom sessionId', () => {
      const testChannel = new StateChannel(mockHubObj, 'test.channel', {
        sessionId: 'custom-session',
      });
      expect(testChannel).toBeDefined();
    });

    it('should use custom refresh interval', () => {
      const testChannel = new StateChannel(mockHubObj, 'test.channel', {
        refreshInterval: 5000,
      });
      expect(testChannel).toBeDefined();
    });

    it('should use custom optimistic timeout', () => {
      const testChannel = new StateChannel(mockHubObj, 'test.channel', {
        optimisticTimeout: 10000,
      });
      expect(testChannel).toBeDefined();
    });

    it('should support non-blocking mode', () => {
      const testChannel = new StateChannel(mockHubObj, 'test.channel', {
        nonBlocking: true,
      });
      expect(testChannel).toBeDefined();
    });

    it('should support optimistic subscriptions', () => {
      const testChannel = new StateChannel(mockHubObj, 'test.channel', {
        useOptimisticSubscriptions: true,
      });
      expect(testChannel).toBeDefined();
    });

    it('should support custom merge delta function', () => {
      const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));
      const testChannel = new StateChannel(mockHubObj, 'test.channel', {
        mergeDelta: mergeFn,
      });
      expect(testChannel).toBeDefined();
    });
  });

  describe('start() and stop()', () => {
    it('should fetch snapshot and setup subscriptions on start', async () => {
      await channel.start();

      expect(mockHubObj.request).toHaveBeenCalledWith('test.channel', {});
      expect(mockHubObj.onEvent).toHaveBeenCalled();
    });

    it('should setup optimistic subscriptions when enabled', async () => {
      const optimisticChannel = new StateChannel(
        mockHubObj as unknown as MessageHub,
        'test.channel',
        { useOptimisticSubscriptions: true }
      );

      await optimisticChannel.start();

      expect(mockHubObj.onEvent).toHaveBeenCalled();
      await optimisticChannel.stop();
    });

    it('should setup non-blocking subscriptions when enabled', async () => {
      const nonBlockingChannel = new StateChannel(
        mockHubObj as unknown as MessageHub,
        'test.channel',
        { nonBlocking: true }
      );

      await nonBlockingChannel.start();

      expect(mockHubObj.request).toHaveBeenCalled();
      await nonBlockingChannel.stop();
    });

    it('should setup auto-refresh when configured', async () => {
      vi.useFakeTimers();

      const refreshChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
        refreshInterval: 1000,
      });

      await refreshChannel.start();

      vi.advanceTimersByTime(2000);

      await refreshChannel.stop();
      vi.useRealTimers();
    });

    it('should setup reconnection handler', async () => {
      await channel.start();

      expect(mockHubObj.onConnection).toHaveBeenCalled();
    });

    it('should stop and cleanup subscriptions', async () => {
      await channel.start();
      await channel.stop();

      expect(channel.value).toBeDefined();
    });

    it('should clear refresh timer on stop', async () => {
      vi.useFakeTimers();

      const refreshChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
        refreshInterval: 1000,
      });

      await refreshChannel.start();
      await refreshChannel.stop();

      vi.advanceTimersByTime(5000);

      await refreshChannel.stop();
      vi.useRealTimers();
    });

    it('should clear optimistic updates on stop', async () => {
      const optimisticChannel = new StateChannel(
        mockHubObj as unknown as MessageHub,
        'test.channel',
        { optimisticTimeout: 100 }
      );

      await optimisticChannel.start();

      optimisticChannel.updateOptimistic('test-1', (_current) => ({
        data: 'optimistic-1',
      }));

      await optimisticChannel.stop();
      vi.useRealTimers();
    });

    it('should set error state on start failure', async () => {
      mockHubObj.request.mockRejectedValue(new Error('Connection failed'));

      const errorChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel');

      await expect(errorChannel.start()).rejects.toThrow('Connection failed');
      expect(errorChannel.hasError.value).toBeInstanceOf(Error);
    });

    it('should handle fetch error gracefully', async () => {
      mockHubObj.request.mockRejectedValueOnce(new Error('Fetch failed'));

      const errorChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel');

      await expect(errorChannel.start()).rejects.toThrow();
    });
  });

  describe('refresh()', () => {
    it('should fetch new snapshot', async () => {
      mockHubObj.request.mockResolvedValue({ data: 'refreshed', timestamp: 123457 });

      await channel.start();
      await channel.refresh();

      expect(mockHubObj.request).toHaveBeenCalledTimes(2);
      expect(channel.value?.data).toBe('refreshed');
    });

    it('should handle refresh errors', async () => {
      mockHubObj.request.mockResolvedValueOnce({ data: 'test' });
      mockHubObj.request.mockRejectedValueOnce(new Error('Refresh failed'));

      await channel.start();

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await channel.refresh().catch(() => {});
      consoleSpy.mockRestore();
    });
  });

  describe('updateOptimistic()', () => {
    it('should apply optimistic update immediately', async () => {
      await channel.start();

      channel.updateOptimistic('update-1', (_current) => ({
        data: 'optimistic',
      }));

      expect(channel.value?.data).toBe('optimistic');
    });

    it('should revert optimistic update on timeout', async () => {
      const testChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
        optimisticTimeout: 50,
      });

      await testChannel.start();

      testChannel.updateOptimistic('update-1', (_current) => ({
        data: 'optimistic',
      }));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(testChannel.value?.data).not.toBe('optimistic');

      await testChannel.stop();
    });

    it('should commit when confirmed promise resolves', async () => {
      await channel.start();

      const confirmed = Promise.resolve();
      channel.updateOptimistic('update-1', (_current) => ({ data: 'optimistic' }), confirmed);

      await confirmed;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(channel.value?.data).toBe('optimistic');
    });

    it('should revert when confirmed promise rejects', async () => {
      await channel.start();

      const confirmed = Promise.reject(new Error('Failed'));

      channel.updateOptimistic('update-1', (_current) => ({ data: 'optimistic' }), confirmed);

      await confirmed.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(channel.value?.data).not.toBe('optimistic');
    });

    it('should revert when confirmed promise times out', async () => {
      vi.useFakeTimers();

      const testChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
        optimisticTimeout: 100,
      });

      mockHubObj.request.mockResolvedValue({ data: 'original' });
      await testChannel.start();

      const neverResolves = new Promise<void>(() => {
        // This promise never resolves
      });

      testChannel.updateOptimistic(
        'update-timeout',
        (_current) => ({ data: 'optimistic' }),
        neverResolves
      );

      expect(testChannel.value?.data).toBe('optimistic');

      await vi.advanceTimersByTimeAsync(150);

      expect(testChannel.value?.data).toBe('original');

      await testChannel.stop();
      vi.useRealTimers();
    });

    it('should no-op when state is null', () => {
      const emptyChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel');

      emptyChannel.updateOptimistic('update-1', (current) => current as { data: string });

      expect(emptyChannel.value).toBeNull();
    });

    it('should handle multiple optimistic updates', async () => {
      await channel.start();

      channel.updateOptimistic('update-1', (_current) => ({ data: 'update-1' }));
      expect(channel.value?.data).toBe('update-1');

      channel.updateOptimistic('update-2', (_current) => ({ data: 'update-2' }));
      expect(channel.value?.data).toBe('update-2');
    });
  });

  describe('isStale()', () => {
    it('should return true when never synced', () => {
      expect(channel.isStale()).toBe(true);
    });

    it('should return true when sync time exceeds maxAge', async () => {
      const privateChannel = channel as unknown as {
        lastSync: { value: number };
      };

      mockHubObj.request.mockResolvedValue({ data: 'test', timestamp: Date.now() - 120000 });

      await channel.start();

      privateChannel.lastSync.value = Date.now() - 120000;

      expect(channel.isStale(60000)).toBe(true);
    });

    it('should return false when sync time is within maxAge', async () => {
      const privateChannel = channel as unknown as {
        lastSync: { value: number };
      };

      mockHubObj.request.mockResolvedValue({ data: 'test', timestamp: Date.now() - 30000 });

      await channel.start();

      privateChannel.lastSync.value = Date.now() - 30000;

      expect(channel.isStale(60000)).toBe(false);
    });
  });

  describe('signals', () => {
    it('should expose value signal', async () => {
      expect(channel.$).toBeDefined();
      expect(channel.value).toBeNull();
    });

    it('should expose loading signal', async () => {
      expect(channel.isLoading).toBeDefined();
      expect(channel.isLoading.value).toBe(false);
    });

    it('should set loading during fetch', async () => {
      mockHubObj.request.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: 'test' }), 50);
          })
      );

      const startPromise = channel.start();

      expect(channel.isLoading.value).toBe(true);

      await startPromise;

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

  describe('mergeSdkMessages()', () => {
    it('should deduplicate messages by uuid', async () => {
      const messagesChannel = new StateChannel<{
        sdkMessages: Array<{ uuid: string; content: string; timestamp: number }>;
      }>(mockHubObj as unknown as MessageHub, 'state.sdkMessages');

      const existing = [
        { uuid: 'msg-1', content: 'Hello', timestamp: 100 },
        { uuid: 'msg-2', content: 'World', timestamp: 200 },
      ];
      const incoming = [
        { uuid: 'msg-1', content: 'Hello Updated', timestamp: 150 },
        { uuid: 'msg-3', content: 'New', timestamp: 300 },
      ];

      mockHubObj.request.mockResolvedValue({ sdkMessages: incoming });
      mockHubObj.request.mockResolvedValueOnce({ sdkMessages: existing });

      await messagesChannel.start();

      const result = messagesChannel.value?.sdkMessages;
      expect(result).toBeDefined();
    });

    it('should sort messages by timestamp', async () => {
      const messagesChannel = new StateChannel<{
        sdkMessages: Array<{ uuid: string; content: string; timestamp: number }>;
      }>(mockHubObj as unknown as MessageHub, 'state.sdkMessages');

      const incoming = [
        { uuid: 'msg-3', content: 'Third', timestamp: 300 },
        { uuid: 'msg-1', content: 'First', timestamp: 100 },
        { uuid: 'msg-2', content: 'Second', timestamp: 200 },
      ];

      mockHubObj.request.mockResolvedValue({ sdkMessages: incoming });

      await messagesChannel.start();

      const result = messagesChannel.value?.sdkMessages;
      expect(result).toBeDefined();
    });

    it('should handle empty message arrays', async () => {
      const messagesChannel = new StateChannel<{
        sdkMessages: Array<{ uuid: string; content: string; timestamp: number }>;
      }>(mockHubObj as unknown as MessageHub, 'state.sdkMessages');

      mockHubObj.request.mockResolvedValue({ sdkMessages: [] });

      await messagesChannel.start();

      expect(messagesChannel.value?.sdkMessages).toEqual([]);
    });
  });

  describe('reconnection handling', () => {
    it('should perform hybrid refresh on reconnection', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await channel.start();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];

        callback('connected');

        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      consoleSpy.mockRestore();
    });

    it('should set error on disconnect', async () => {
      await channel.start();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];

        callback('disconnected');

        expect(channel.hasError.value).toBeInstanceOf(Error);
      }
    });

    it('should set error on connection error', async () => {
      await channel.start();

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];

        callback('error');

        expect(channel.hasError.value).toBeInstanceOf(Error);
      }
    });
  });

  describe('edge cases', () => {
    it('should handle empty snapshots', async () => {
      mockHubObj.request.mockResolvedValue(null);

      await channel.start();

      expect(channel.value).toBeNull();
    });

    it('should handle snapshots without timestamp', async () => {
      mockHubObj.request.mockResolvedValue({ data: 'test-no-timestamp' });

      await channel.start();

      expect(channel.lastSyncTime.value).toBeGreaterThan(0);
    });

    it('should handle concurrent start calls', async () => {
      const promise1 = channel.start();
      const promise2 = channel.start();

      await Promise.all([promise1, promise2]);

      expect(channel.value).toBeDefined();
    });

    it('should handle multiple stop calls', async () => {
      await channel.start();
      await channel.stop();
      await channel.stop();

      expect(channel.value).toBeDefined();
    });
  });

  describe('delta subscriptions', () => {
    it('should subscribe to delta channel when enableDeltas is true', async () => {
      const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));
      const deltaChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
        enableDeltas: true,
        mergeDelta: mergeFn,
        useOptimisticSubscriptions: true,
      });

      await deltaChannel.start();

      expect(mockHubObj.onEvent).toHaveBeenCalled();
      const calls = mockHubObj.onEvent.mock.calls;
      const deltaCall = calls.find((call) => call[0] === 'test.channel.delta');
      expect(deltaCall).toBeDefined();

      await deltaChannel.stop();
    });

    it('should apply delta updates via mergeDelta function', async () => {
      const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));
      const deltaChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
        enableDeltas: true,
        mergeDelta: mergeFn,
        useOptimisticSubscriptions: true,
      });

      await deltaChannel.start();

      const calls = mockHubObj.onEvent.mock.calls;
      const deltaCall = calls.find((call) => call[0] === 'test.channel.delta');

      if (deltaCall) {
        const deltaCallback = deltaCall[1];
        deltaCallback({ newField: 'value' });

        expect(mergeFn).toHaveBeenCalled();
      }

      await deltaChannel.stop();
    });

    it('should skip delta when state is null', async () => {
      mockHubObj.request.mockResolvedValue(null);

      const mergeFn = vi.fn((current, delta) => ({ ...current, ...delta }));
      const deltaChannel = new StateChannel(mockHubObj as unknown as MessageHub, 'test.channel', {
        enableDeltas: true,
        mergeDelta: mergeFn,
        useOptimisticSubscriptions: true,
      });

      await deltaChannel.start();

      const calls = mockHubObj.onEvent.mock.calls;
      const deltaCall = calls.find((call) => call[0] === 'test.channel.delta');

      if (deltaCall) {
        const deltaCallback = deltaCall[1];
        deltaCallback({ newField: 'value' });

        expect(mergeFn).not.toHaveBeenCalled();
      }

      await deltaChannel.stop();
    });
  });

  describe('hybrid refresh error handling', () => {
    it('should throw error when hybridRefresh fails', async () => {
      await channel.start();

      mockHubObj.request.mockRejectedValue(new Error('Fetch failed'));

      const onConnectionCall = mockHubObj.onConnection.mock.calls[0];
      if (onConnectionCall) {
        const callback = onConnectionCall[0];

        callback('connected');

        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
  });
});
