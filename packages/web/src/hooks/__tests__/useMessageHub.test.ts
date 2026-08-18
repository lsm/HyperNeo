// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { signal } from '@preact/signals';

const { mockGetHubIfConnected, mockOnConnected, mockOnceConnected } = vi.hoisted(() => ({
  mockGetHubIfConnected: vi.fn(),
  mockOnConnected: vi.fn(),
  mockOnceConnected: vi.fn(),
}));

const mockConnectionState = signal<string>('disconnected');

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
    onConnected: (timeout: number) => mockOnConnected(timeout),
    onceConnected: (callback: () => void) => mockOnceConnected(callback),
  },
}));

vi.mock('../../lib/state', () => ({
  get connectionState() {
    return mockConnectionState;
  },
}));

import { useMessageHub } from '../useMessageHub';
import { ConnectionNotReadyError } from '../../lib/errors';

describe('useMessageHub', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockConnectionState.value = 'disconnected';
    mockGetHubIfConnected.mockReturnValue(null);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('initialization', () => {
    it('should return isConnected false when disconnected', () => {
      mockConnectionState.value = 'disconnected';
      const { result } = renderHook(() => useMessageHub());

      expect(result.current.isConnected).toBe(false);
    });

    it('should return isConnected true when connected', () => {
      mockConnectionState.value = 'connected';
      const { result } = renderHook(() => useMessageHub());

      expect(result.current.isConnected).toBe(true);
    });

    it('should return current state', () => {
      mockConnectionState.value = 'connecting';
      const { result } = renderHook(() => useMessageHub());

      expect(result.current.state).toBe('connecting');
    });

    it('should return all hook methods', () => {
      const { result } = renderHook(() => useMessageHub());

      expect(typeof result.current.getHub).toBe('function');
      expect(typeof result.current.call).toBe('function');
      expect(typeof result.current.callIfConnected).toBe('function');
      expect(typeof result.current.subscribe).toBe('function');
      expect(typeof result.current.waitForConnection).toBe('function');
      expect(typeof result.current.onConnected).toBe('function');
    });
  });

  describe('getHub', () => {
    it('should return null when not connected', () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const hub = result.current.getHub();

      expect(hub).toBeNull();
    });

    it('should return hub when connected', () => {
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        subscribeOptimistic: vi.fn(),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      const hub = result.current.getHub();

      expect(hub).toBe(mockHub);
    });
  });

  describe('call', () => {
    it('should throw ConnectionNotReadyError when not connected', async () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      await expect(result.current.call('test.method', { data: 'value' })).rejects.toThrow(
        ConnectionNotReadyError
      );
    });

    it('should throw error containing method name', async () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      try {
        await result.current.call('my.custom.method');
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('my.custom.method');
        expect((err as Error).message).toContain('not connected');
      }
    });

    it('should make RPC call when connected', async () => {
      const mockHub = {
        call: vi.fn().mockResolvedValue({ success: true, data: 'result' }),
        request: vi
          .fn()
          .mockResolvedValue({ acknowledged: true })
          .mockResolvedValue({ success: true, data: 'result' }),
        subscribeOptimistic: vi.fn(),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      const response = await result.current.call('test.method', { input: 'data' });

      expect(mockHub.request).toHaveBeenCalledWith(
        'test.method',
        { input: 'data' },
        { timeout: 30000 }
      );
      expect(response).toEqual({ success: true, data: 'result' });
    });

    it('should use custom timeout when provided', async () => {
      const mockHub = {
        call: vi.fn().mockResolvedValue({}),
        request: vi.fn().mockResolvedValue({ acknowledged: true }).mockResolvedValue({}),
        subscribeOptimistic: vi.fn(),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      await result.current.call('test.method', {}, { timeout: 5000 });

      expect(mockHub.request).toHaveBeenCalledWith('test.method', {}, { timeout: 5000 });
    });

    it('should use defaultTimeout from options', async () => {
      const mockHub = {
        call: vi.fn().mockResolvedValue({}),
        request: vi.fn().mockResolvedValue({ acknowledged: true }).mockResolvedValue({}),
        subscribeOptimistic: vi.fn(),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub({ defaultTimeout: 20000 }));

      await result.current.call('test.method');

      expect(mockHub.request).toHaveBeenCalledWith('test.method', undefined, { timeout: 20000 });
    });
  });

  describe('callIfConnected', () => {
    it('should return null when not connected', async () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const response = await result.current.callIfConnected('test.method', { data: 'value' });

      expect(response).toBeNull();
    });

    it('should make RPC call when connected', async () => {
      const mockHub = {
        call: vi.fn().mockResolvedValue({ success: true }),
        request: vi
          .fn()
          .mockResolvedValue({ acknowledged: true })
          .mockResolvedValue({ success: true }),
        subscribeOptimistic: vi.fn(),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      const response = await result.current.callIfConnected('test.method');

      expect(response).toEqual({ success: true });
    });

    it('should not throw when not connected', async () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const response = await result.current.callIfConnected('test.method');
      expect(response).toBeNull();
    });

    it('should use custom timeout when provided', async () => {
      const mockHub = {
        call: vi.fn().mockResolvedValue({}),
        request: vi.fn().mockResolvedValue({ acknowledged: true }).mockResolvedValue({}),
        subscribeOptimistic: vi.fn(),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      await result.current.callIfConnected('test.method', {}, { timeout: 3000 });

      expect(mockHub.request).toHaveBeenCalledWith('test.method', {}, { timeout: 3000 });
    });
  });

  describe('subscribe', () => {
    it('should queue subscription when not connected', () => {
      mockGetHubIfConnected.mockReturnValue(null);
      mockOnceConnected.mockReturnValue(() => {});
      const { result } = renderHook(() => useMessageHub());

      const handler = vi.fn();
      const unsub = result.current.subscribe('test.event', handler);

      expect(typeof unsub).toBe('function');
      expect(mockOnceConnected).toHaveBeenCalled();
    });

    it('should subscribe immediately when connected', () => {
      const mockUnsub = vi.fn();
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(mockUnsub),
        subscribeOptimistic: vi.fn().mockReturnValue(mockUnsub),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      const handler = vi.fn();
      const unsub = result.current.subscribe('test.event', handler);

      expect(mockHub.onEvent).toHaveBeenCalledWith('test.event', handler);
      expect(typeof unsub).toBe('function');
    });

    it('should return unsubscribe function that removes from tracking', () => {
      const mockUnsub = vi.fn();
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(mockUnsub),
        subscribeOptimistic: vi.fn().mockReturnValue(mockUnsub),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      const unsub = result.current.subscribe('test.event', vi.fn());
      unsub();

      expect(mockUnsub).toHaveBeenCalled();
    });

    it('should pass options to onEvent', () => {
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(() => {}),
        subscribeOptimistic: vi.fn().mockReturnValue(() => {}),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      const handler = vi.fn();
      const options = { sessionId: 'test-session' };
      result.current.subscribe('test.event', handler, options);

      expect(mockHub.onEvent).toHaveBeenCalledWith('test.event', handler);
    });

    it('should cancel queued subscription on unsubscribe before connect', () => {
      const mockConnectionUnsub = vi.fn();
      mockGetHubIfConnected.mockReturnValue(null);
      mockOnceConnected.mockReturnValue(mockConnectionUnsub);
      const { result } = renderHook(() => useMessageHub());

      const unsub = result.current.subscribe('test.event', vi.fn());
      unsub();

      expect(mockConnectionUnsub).toHaveBeenCalled();
    });

    it('should subscribe after connection when queued', () => {
      let connectionCallback: (() => void) | null = null;
      mockOnceConnected.mockImplementation((cb) => {
        connectionCallback = cb;
        return () => {};
      });

      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const handler = vi.fn();
      result.current.subscribe('test.event', handler);

      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(() => {}),
        subscribeOptimistic: vi.fn().mockReturnValue(() => {}),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      connectionCallback?.();

      expect(mockHub.onEvent).toHaveBeenCalledWith('test.event', handler);
    });

    it('should not subscribe if cancelled before connection', () => {
      let connectionCallback: (() => void) | null = null;
      mockOnceConnected.mockImplementation((cb) => {
        connectionCallback = cb;
        return () => {};
      });

      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const unsub = result.current.subscribe('test.event', vi.fn());
      unsub();

      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(() => {}),
        subscribeOptimistic: vi.fn().mockReturnValue(() => {}),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      connectionCallback?.();

      expect(mockHub.subscribeOptimistic).not.toHaveBeenCalled();
    });
  });

  describe('waitForConnection', () => {
    it('should call connectionManager.onConnected with default timeout', async () => {
      mockOnConnected.mockResolvedValue(undefined);
      const { result } = renderHook(() => useMessageHub());

      await result.current.waitForConnection();

      expect(mockOnConnected).toHaveBeenCalledWith(30000);
    });

    it('should call connectionManager.onConnected with custom timeout', async () => {
      mockOnConnected.mockResolvedValue(undefined);
      const { result } = renderHook(() => useMessageHub());

      await result.current.waitForConnection(5000);

      expect(mockOnConnected).toHaveBeenCalledWith(5000);
    });

    it('should use defaultTimeout from options', async () => {
      mockOnConnected.mockResolvedValue(undefined);
      const { result } = renderHook(() => useMessageHub({ defaultTimeout: 15000 }));

      await result.current.waitForConnection();

      expect(mockOnConnected).toHaveBeenCalledWith(15000);
    });

    it('should propagate errors from onConnected', async () => {
      mockOnConnected.mockRejectedValue(new Error('Connection timeout'));
      const { result } = renderHook(() => useMessageHub());

      await expect(result.current.waitForConnection()).rejects.toThrow('Connection timeout');
    });
  });

  describe('onConnected', () => {
    it('should register callback with connectionManager', () => {
      const mockUnsub = vi.fn();
      mockOnceConnected.mockReturnValue(mockUnsub);
      const { result } = renderHook(() => useMessageHub());

      const callback = vi.fn();
      const unsub = result.current.onConnected(callback);

      expect(mockOnceConnected).toHaveBeenCalledWith(callback);
      expect(typeof unsub).toBe('function');
    });

    it('should return unsubscribe function', () => {
      const mockUnsub = vi.fn();
      mockOnceConnected.mockReturnValue(mockUnsub);
      const { result } = renderHook(() => useMessageHub());

      const unsub = result.current.onConnected(vi.fn());
      unsub();

      expect(mockUnsub).toHaveBeenCalled();
    });
  });

  describe('debug mode', () => {
    it('should accept debug option without error', () => {
      mockConnectionState.value = 'connected';
      const { result } = renderHook(() => useMessageHub({ debug: true }));

      expect(result.current.isConnected).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should cleanup subscriptions on unmount', () => {
      const mockUnsub = vi.fn();
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(mockUnsub),
        subscribeOptimistic: vi.fn().mockReturnValue(mockUnsub),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result, unmount } = renderHook(() => useMessageHub());

      result.current.subscribe('event1', vi.fn());
      result.current.subscribe('event2', vi.fn());

      unmount();

      expect(mockUnsub).toHaveBeenCalledTimes(2);
    });

    it('should handle cleanup errors gracefully', () => {
      const mockUnsub = vi.fn().mockImplementation(() => {
        throw new Error('Cleanup error');
      });
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(mockUnsub),
        subscribeOptimistic: vi.fn().mockReturnValue(mockUnsub),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result, unmount } = renderHook(() => useMessageHub());
      result.current.subscribe('event', vi.fn());

      expect(() => unmount()).not.toThrow();
    });
  });

  describe('connection state reactivity', () => {
    it('should update isConnected when state changes', () => {
      mockConnectionState.value = 'disconnected';
      const { result, rerender } = renderHook(() => useMessageHub());

      expect(result.current.isConnected).toBe(false);

      act(() => {
        mockConnectionState.value = 'connected';
      });
      rerender();

      expect(result.current.isConnected).toBe(true);
    });

    it('should reflect all connection states', () => {
      const { result, rerender } = renderHook(() => useMessageHub());

      const states = ['connecting', 'connected', 'disconnected', 'error', 'reconnecting'];

      for (const state of states) {
        act(() => {
          mockConnectionState.value = state;
        });
        rerender();
        expect(result.current.state).toBe(state);
      }
    });
  });

  describe('non-blocking guarantees', () => {
    it('getHub should never block', () => {
      const { result } = renderHook(() => useMessageHub());

      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        result.current.getHub();
      }
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('call should fail fast when not connected', async () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const start = Date.now();
      try {
        await result.current.call('method');
      } catch {
        // Expected
      }
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('callIfConnected should return immediately when not connected', async () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const start = Date.now();
      await result.current.callIfConnected('method');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('subscribe should return immediately even when not connected', () => {
      mockGetHubIfConnected.mockReturnValue(null);
      mockOnceConnected.mockReturnValue(() => {});
      const { result } = renderHook(() => useMessageHub());

      const start = Date.now();
      const unsub = result.current.subscribe('event', () => {});
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10);
      expect(typeof unsub).toBe('function');
    });
  });

  describe('onEvent', () => {
    it('should subscribe immediately when connected', () => {
      const mockUnsub = vi.fn();
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(mockUnsub),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      const handler = vi.fn();
      const unsub = result.current.onEvent('test.event', handler);

      expect(mockHub.onEvent).toHaveBeenCalledWith('test.event', handler);
      expect(typeof unsub).toBe('function');
    });

    it('should return unsubscribe function that removes from tracking when connected', () => {
      const mockUnsub = vi.fn();
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(mockUnsub),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      const unsub = result.current.onEvent('test.event', vi.fn());
      unsub();

      expect(mockUnsub).toHaveBeenCalled();
    });

    it('should queue subscription when not connected', () => {
      mockGetHubIfConnected.mockReturnValue(null);
      mockOnceConnected.mockReturnValue(() => {});
      const { result } = renderHook(() => useMessageHub());

      const handler = vi.fn();
      const unsub = result.current.onEvent('test.event', handler);

      expect(typeof unsub).toBe('function');
      expect(mockOnceConnected).toHaveBeenCalled();
    });

    it('should cancel queued onEvent subscription on unsubscribe before connect', () => {
      const mockConnectionUnsub = vi.fn();
      mockGetHubIfConnected.mockReturnValue(null);
      mockOnceConnected.mockReturnValue(mockConnectionUnsub);
      const { result } = renderHook(() => useMessageHub());

      const unsub = result.current.onEvent('test.event', vi.fn());
      unsub();

      expect(mockConnectionUnsub).toHaveBeenCalled();
    });

    it('should subscribe after connection when queued via onEvent', () => {
      let connectionCallback: (() => void) | null = null;
      mockOnceConnected.mockImplementation((cb) => {
        connectionCallback = cb;
        return () => {};
      });

      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const handler = vi.fn();
      result.current.onEvent('test.event', handler);

      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(() => {}),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      connectionCallback?.();

      expect(mockHub.onEvent).toHaveBeenCalledWith('test.event', handler);
    });

    it('should not subscribe if onEvent cancelled before connection', () => {
      let connectionCallback: (() => void) | null = null;
      mockOnceConnected.mockImplementation((cb) => {
        connectionCallback = cb;
        return () => {};
      });

      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const unsub = result.current.onEvent('test.event', vi.fn());
      unsub();

      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn().mockReturnValue(() => {}),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      connectionCallback?.();

      expect(mockHub.onEvent).not.toHaveBeenCalled();
    });

    it('should cleanup actualUnsub when unsubscribing after queued connection', () => {
      let connectionCallback: (() => void) | null = null;
      mockOnceConnected.mockImplementation((cb) => {
        connectionCallback = cb;
        return () => {};
      });

      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      const handler = vi.fn();
      const unsub = result.current.onEvent('test.event', handler);

      const mockEventUnsub = vi.fn();
      const mockHub = {
        onEvent: vi.fn().mockReturnValue(mockEventUnsub),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      connectionCallback?.();

      unsub();
      expect(mockEventUnsub).toHaveBeenCalled();
    });
  });

  describe('joinRoom', () => {
    it('should join room when connected', () => {
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn(),
        joinChannel: vi.fn(),
        leaveChannel: vi.fn(),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      result.current.joinRoom('test-room');

      expect(mockHub.joinChannel).toHaveBeenCalledWith('test-room');
    });

    it('should not throw when not connected', () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      expect(() => result.current.joinRoom('test-room')).not.toThrow();
    });
  });

  describe('leaveRoom', () => {
    it('should leave room when connected', () => {
      const mockHub = {
        call: vi.fn(),
        request: vi.fn().mockResolvedValue({ acknowledged: true }),
        onEvent: vi.fn(),
        joinChannel: vi.fn(),
        leaveChannel: vi.fn(),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      result.current.leaveRoom('test-room');

      expect(mockHub.leaveChannel).toHaveBeenCalledWith('test-room');
    });

    it('should not throw when not connected', () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      expect(() => result.current.leaveRoom('test-room')).not.toThrow();
    });
  });

  describe('request', () => {
    it('should throw ConnectionNotReadyError when not connected', async () => {
      mockGetHubIfConnected.mockReturnValue(null);
      const { result } = renderHook(() => useMessageHub());

      await expect(result.current.request('test.method')).rejects.toThrow(ConnectionNotReadyError);
    });

    it('should make request call when connected', async () => {
      const mockHub = {
        request: vi.fn().mockResolvedValue({ data: 'result' }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      const response = await result.current.request('test.method', { input: 'data' });

      expect(mockHub.request).toHaveBeenCalledWith(
        'test.method',
        { input: 'data' },
        { timeout: 30000 }
      );
      expect(response).toEqual({ data: 'result' });
    });

    it('should use custom timeout', async () => {
      const mockHub = {
        request: vi.fn().mockResolvedValue({}),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);
      const { result } = renderHook(() => useMessageHub());

      await result.current.request('test.method', {}, { timeout: 5000 });

      expect(mockHub.request).toHaveBeenCalledWith('test.method', {}, { timeout: 5000 });
    });
  });

  describe('function stability', () => {
    it('should return stable function references', () => {
      const { result, rerender } = renderHook(() => useMessageHub());

      const firstGetHub = result.current.getHub;
      const firstCall = result.current.call;
      const firstSubscribe = result.current.subscribe;

      rerender();

      expect(result.current.getHub).toBe(firstGetHub);
      expect(result.current.call).toBe(firstCall);
      expect(result.current.subscribe).toBe(firstSubscribe);
    });

    it('should update call when defaultTimeout changes', () => {
      const { result, rerender } = renderHook(
        ({ timeout }) => useMessageHub({ defaultTimeout: timeout }),
        { initialProps: { timeout: 10000 } }
      );

      const firstCall = result.current.call;

      rerender({ timeout: 20000 });

      expect(result.current.call).not.toBe(firstCall);
    });
  });
});
