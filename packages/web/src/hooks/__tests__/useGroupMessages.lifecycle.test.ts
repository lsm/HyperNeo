import { act, renderHook } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockOnEvent, mockIsConnected } = vi.hoisted(() => ({
  mockRequest: vi.fn().mockResolvedValue({ ok: true }),
  mockOnEvent: vi.fn<(method: string, handler: (event: unknown) => void) => () => void>(
    () => () => {}
  ),
  mockIsConnected: { value: true },
}));

vi.mock('../useMessageHub', () => ({
  useMessageHub: () => ({
    request: mockRequest,
    onEvent: mockOnEvent,
    get isConnected() {
      return mockIsConnected.value;
    },
  }),
}));

type EventHandler = (event: unknown) => void;
let eventHandlers: Record<string, EventHandler[]> = {};

function fireEvent(method: string, payload: unknown): void {
  (eventHandlers[method] ?? []).forEach((h) => h(payload));
}

function subscribeCalls() {
  return mockRequest.mock.calls.filter((call) => call[0] === 'liveQuery.subscribe');
}

function unsubscribeCalls() {
  return mockRequest.mock.calls.filter((call) => call[0] === 'liveQuery.unsubscribe');
}

function makeMessage(id: number, content = `msg-${id}`) {
  return {
    id,
    groupId: 'group-1',
    sessionId: null,
    role: 'assistant',
    messageType: 'text',
    content,
    createdAt: 1_000_000 + id,
  };
}

import { useGroupMessages, type SessionGroupMessage } from '../useGroupMessages';

describe('useGroupMessages liveQuery lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockRequest.mockReset();
    mockOnEvent.mockReset();
    mockRequest.mockResolvedValue({ ok: true });
    mockIsConnected.value = true;
    eventHandlers = {};
    mockOnEvent.mockImplementation((method: string, handler: EventHandler) => {
      if (!eventHandlers[method]) eventHandlers[method] = [];
      eventHandlers[method].push(handler);
      return () => {
        eventHandlers[method] = (eventHandlers[method] ?? []).filter((h) => h !== handler);
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('subscribe retry ladder', () => {
    it('retries a rejected subscribe at 500ms then 1500ms and settles empty after the third rejection', async () => {
      vi.useFakeTimers();
      mockRequest.mockRejectedValue(new Error('subscribe failed'));
      const { result } = renderHook(() => useGroupMessages('group-1'));

      expect(subscribeCalls()).toHaveLength(1);
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(499);
      });
      expect(subscribeCalls()).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(2);
      await act(async () => {
        vi.advanceTimersByTime(1499);
      });
      expect(subscribeCalls()).toHaveLength(2);
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(3);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.messages).toEqual([]);
      await act(async () => {
        vi.advanceTimersByTime(10000);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(3);
    });

    it('stops the ladder once an attempt succeeds and then waits indefinitely for the snapshot', async () => {
      vi.useFakeTimers();
      mockRequest.mockRejectedValueOnce(new Error('first attempt failed'));
      const { result } = renderHook(() => useGroupMessages('group-1'));

      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(2);
      expect(result.current.isLoading).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(2);
      expect(result.current.isLoading).toBe(true);

      const subId = subscribeCalls()[1][1].subscriptionId;
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });
      expect(result.current.messages.map((m) => m.id)).toEqual([1]);
      expect(result.current.isLoading).toBe(false);
    });

    it('adopts a late snapshot even after the retry ladder exhausted', async () => {
      vi.useFakeTimers();
      mockRequest.mockRejectedValue(new Error('subscribe failed'));
      const { result } = renderHook(() => useGroupMessages('group-1'));
      const subId = subscribeCalls()[0][1].subscriptionId;

      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      expect(result.current.isLoading).toBe(false);

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(7)],
          version: 1,
        });
      });
      expect(result.current.messages.map((m) => m.id)).toEqual([7]);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('liveQuery.error handling', () => {
    it('immediately re-requests the same subscription on a delta-phase error and adopts the follow-up snapshot', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));
      const subId = subscribeCalls()[0][1].subscriptionId;

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });
      expect(result.current.isLoading).toBe(false);

      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'STREAM_LOST',
          message: 'stream lost',
          phase: 'delta',
        });
      });
      expect(subscribeCalls()).toHaveLength(2);
      expect(subscribeCalls()[1][1].subscriptionId).toBe(subId);
      expect(result.current.messages.map((m) => m.id)).toEqual([1]);
      expect(result.current.isLoading).toBe(false);

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2)],
          version: 2,
        });
      });
      expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]);
    });

    it('leaves the loaded state intact when the resubscribe after a delta-phase error keeps failing', async () => {
      vi.useFakeTimers();
      mockRequest.mockResolvedValueOnce({ ok: true }).mockRejectedValue(new Error('down'));
      const { result } = renderHook(() => useGroupMessages('group-1'));
      const subId = subscribeCalls()[0][1].subscriptionId;

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });
      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'STREAM_LOST',
          message: 'stream lost',
          phase: 'delta',
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });
      expect(result.current.messages.map((m) => m.id)).toEqual([1]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isReconnecting).toBe(false);
    });

    it('releases loading on a snapshot-phase error and still adopts a later snapshot', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));
      const subId = subscribeCalls()[0][1].subscriptionId;

      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'QUERY_FAILED',
          message: 'query failed',
          phase: 'snapshot',
        });
      });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.messages).toEqual([]);

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(3)],
          version: 1,
        });
      });
      expect(result.current.messages.map((m) => m.id)).toEqual([3]);
      expect(result.current.isLoading).toBe(false);
    });

    it('retains loaded rows on a snapshot-phase error after loading', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));
      const subId = subscribeCalls()[0][1].subscriptionId;

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });
      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'QUERY_FAILED',
          message: 'query failed',
          phase: 'snapshot',
        });
      });
      expect(result.current.messages.map((m) => m.id)).toEqual([1]);
      expect(result.current.isLoading).toBe(false);
    });

    it('ignores liveQuery.error events for a stale subscriptionId', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: 'stale-error-sub-9999',
          code: 'STREAM_LOST',
          message: 'stream lost',
          phase: 'delta',
        });
      });
      expect(subscribeCalls()).toHaveLength(1);
      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('reconnect', () => {
    it('resets with a fresh subscriptionId across a disconnect/connect flip and drops the old stream', () => {
      const { result, rerender } = renderHook(
        ({ isConn }: { isConn: boolean }) => {
          mockIsConnected.value = isConn;
          return useGroupMessages('group-1');
        },
        { initialProps: { isConn: true } }
      );
      const firstSubId = subscribeCalls()[0][1].subscriptionId;

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });
      expect(result.current.messages).toHaveLength(1);

      act(() => {
        rerender({ isConn: false });
      });
      expect(result.current.isReconnecting).toBe(true);
      expect(result.current.messages).toEqual([]);

      act(() => {
        rerender({ isConn: true });
      });
      expect(result.current.isLoading).toBe(true);
      expect(subscribeCalls()).toHaveLength(2);
      const reconnectSubId = subscribeCalls()[1][1].subscriptionId;
      expect(reconnectSubId).not.toBe(firstSubId);

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: firstSubId,
          added: [makeMessage(99)],
          version: 2,
        });
      });
      expect(result.current.messages).toEqual([]);
    });
  });

  describe('listener registration and cleanup', () => {
    it('registers exactly the snapshot, delta, and error listeners', () => {
      renderHook(() => useGroupMessages('group-1'));
      expect(mockOnEvent.mock.calls.map((call) => call[0])).toEqual([
        'liveQuery.snapshot',
        'liveQuery.delta',
        'liveQuery.error',
      ]);
    });

    it('unsubscribes on unmount and stays inert afterwards', async () => {
      vi.useFakeTimers();
      mockRequest.mockRejectedValue(new Error('subscribe failed'));
      const { unmount } = renderHook(() => useGroupMessages('group-1'));
      const subId = subscribeCalls()[0][1].subscriptionId;

      await act(async () => {
        await Promise.resolve();
      });
      unmount();
      expect(unsubscribeCalls()).toEqual([['liveQuery.unsubscribe', { subscriptionId: subId }]]);

      await act(async () => {
        vi.advanceTimersByTime(10000);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(1);

      fireEvent('liveQuery.snapshot', {
        subscriptionId: subId,
        rows: [makeMessage(1) as SessionGroupMessage],
        version: 2,
      });
      fireEvent('liveQuery.delta', {
        subscriptionId: subId,
        added: [makeMessage(2)],
        version: 3,
      });
      fireEvent('liveQuery.error', {
        subscriptionId: subId,
        code: 'STREAM_LOST',
        message: 'late',
        phase: 'delta',
      });
      expect(subscribeCalls()).toHaveLength(1);
    });
  });
});
