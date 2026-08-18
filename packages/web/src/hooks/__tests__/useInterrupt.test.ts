// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';

const { mockGetHubIfConnected, mockToastError } = vi.hoisted(() => ({
  mockGetHubIfConnected: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
  },
}));

vi.mock('../../lib/toast', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

import { useInterrupt } from '../useInterrupt';

describe('useInterrupt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mockGetHubIfConnected.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe('initial state', () => {
    it('should return interrupting as false initially', () => {
      const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));
      expect(result.current.interrupting).toBe(false);
    });

    it('should return handleInterrupt as a function', () => {
      const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));
      expect(typeof result.current.handleInterrupt).toBe('function');
    });
  });

  describe('session change reset', () => {
    it('should reset interrupting state when sessionId changes', async () => {
      const mockHub = {
        request: vi.fn().mockResolvedValue(undefined),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result, rerender } = renderHook(({ sessionId }) => useInterrupt({ sessionId }), {
        initialProps: { sessionId: 'session-1' },
      });

      await act(async () => {
        await result.current.handleInterrupt();
      });

      expect(result.current.interrupting).toBe(true);

      rerender({ sessionId: 'session-2' });
      expect(result.current.interrupting).toBe(false);
    });
  });

  describe('handleInterrupt - not connected', () => {
    it('should show toast error when not connected', async () => {
      mockGetHubIfConnected.mockReturnValue(null);

      const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

      await act(async () => {
        await result.current.handleInterrupt();
      });

      expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
    });
  });

  describe('handleInterrupt - connected', () => {
    it('should call client.interrupt with sessionId', async () => {
      const mockHub = {
        request: vi.fn().mockResolvedValue(undefined),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

      await act(async () => {
        await result.current.handleInterrupt();
      });

      expect(mockHub.request).toHaveBeenCalledWith('client.interrupt', { sessionId: 'session-1' });
    });

    it('should set interrupting to true during request', async () => {
      const mockHub = {
        request: vi.fn().mockResolvedValue(undefined),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

      await act(async () => {
        await result.current.handleInterrupt();
      });

      expect(result.current.interrupting).toBe(true);
    });

    it('should reset interrupting after 500ms timeout', async () => {
      const mockHub = {
        request: vi.fn().mockResolvedValue(undefined),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

      await act(async () => {
        await result.current.handleInterrupt();
      });

      expect(result.current.interrupting).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(result.current.interrupting).toBe(false);
    });

    it('should not call interrupt again if already interrupting', async () => {
      const mockHub = {
        request: vi.fn().mockResolvedValue(undefined),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

      await act(async () => {
        await result.current.handleInterrupt();
      });

      await act(async () => {
        await result.current.handleInterrupt();
      });

      expect(mockHub.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleInterrupt - error handling', () => {
    it('should show toast error when request fails', async () => {
      const mockHub = {
        request: vi.fn().mockRejectedValue(new Error('Network error')),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

      await act(async () => {
        await result.current.handleInterrupt();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to stop generation');
    });

    it('should still reset interrupting after error', async () => {
      const mockHub = {
        request: vi.fn().mockRejectedValue(new Error('Network error')),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useInterrupt({ sessionId: 'session-1' }));

      await act(async () => {
        await result.current.handleInterrupt();
      });

      expect(result.current.interrupting).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(result.current.interrupting).toBe(false);
    });
  });
});
