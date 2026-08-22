import { act, renderHook } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockOnEvent, mockGetHub, mockIsConnected } = vi.hoisted(() => ({
  mockRequest: vi.fn().mockResolvedValue(undefined),
  mockOnEvent: vi.fn<(method: string, handler: (event: unknown) => void) => () => void>(
    () => () => {}
  ),
  mockGetHub: vi.fn(),
  mockIsConnected: { value: true },
}));

vi.mock('../useMessageHub', () => ({
  useMessageHub: () => ({
    request: mockRequest,
    onEvent: mockOnEvent,
    getHub: mockGetHub,
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

function messageSubscribeCalls() {
  return subscribeCalls().filter((call) =>
    String(call[1].queryName).startsWith('spaceTaskMessages.')
  );
}

function activeTurnSubscribeCalls() {
  return subscribeCalls().filter((call) => call[1].queryName === 'spaceTaskActiveTurn.byTask');
}

function unsubscribeCalls() {
  return mockRequest.mock.calls.filter((call) => call[0] === 'liveQuery.unsubscribe');
}

function lastMessageSubscribeSubId(): string {
  const calls = messageSubscribeCalls();
  return calls[calls.length - 1][1].subscriptionId;
}

function lastActiveTurnSubscribeSubId(): string {
  const calls = activeTurnSubscribeCalls();
  return calls[calls.length - 1][1].subscriptionId;
}

function makeRow(id: string | number, createdAt: number, content = '') {
  return {
    id,
    sessionId: 'sess-1',
    kind: 'task_agent',
    role: 'user',
    label: '',
    taskId: 'task-1',
    taskTitle: '',
    messageType: 'user',
    content,
    createdAt,
  } as never;
}

function makeActiveTurnRow(sessionId: string, ts: number, text = 'Working') {
  return {
    id: `${sessionId}:1:${ts}:0`,
    sessionId,
    turnIndex: 1,
    ts,
    entry: { kind: 'text', text, ts, uuid: `u-${sessionId}-${ts}` },
  } as never;
}

import { useSpaceTaskMessages } from '../useSpaceTaskMessages';

describe('useSpaceTaskMessages liveQuery lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockRequest.mockReset();
    mockOnEvent.mockReset();
    mockGetHub.mockReset();
    mockRequest.mockResolvedValue(undefined);
    mockGetHub.mockReturnValue({ request: mockRequest, onConnection: vi.fn(() => () => {}) });
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

  describe('await-snapshot retry backoff', () => {
    it('waits the full 2000ms backoff before the first snapshot retry', async () => {
      vi.useFakeTimers();
      renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      await act(async () => {
        await Promise.resolve();
      });
      expect(messageSubscribeCalls()).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(1999);
      });
      expect(messageSubscribeCalls()).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(messageSubscribeCalls()).toHaveLength(2);
      expect(messageSubscribeCalls()[1][1].subscriptionId).toBe(subId);
    });

    it('stops after five snapshot retries and releases loading without an error', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.isLoading).toBe(true);
      for (let i = 0; i < 5; i += 1) {
        await act(async () => {
          vi.advanceTimersByTime(2000);
          await Promise.resolve();
        });
      }
      expect(messageSubscribeCalls()).toHaveLength(6);
      expect(activeTurnSubscribeCalls()).toHaveLength(6);
      expect(new Set(messageSubscribeCalls().map((call) => call[1].subscriptionId)).size).toBe(1);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.rows).toEqual([]);
      expect(result.current.error).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(10000);
        await Promise.resolve();
      });
      expect(messageSubscribeCalls()).toHaveLength(6);
    });

    it('cancels pending snapshot retries once a snapshot arrives', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('m1', 1, 'hello')],
          version: 1,
        });
      });
      expect(result.current.isLoading).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(10000);
        await Promise.resolve();
      });
      expect(messageSubscribeCalls()).toHaveLength(1);
      expect(activeTurnSubscribeCalls()).toHaveLength(1);
    });
  });

  describe('generation guard', () => {
    it('ignores retry timers from a superseded subscribe generation', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
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
        await Promise.resolve();
      });
      expect(messageSubscribeCalls()).toHaveLength(2);
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      expect(messageSubscribeCalls()).toHaveLength(2);
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      expect(messageSubscribeCalls()).toHaveLength(3);
      expect(result.current.isLoading).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('ignores snapshots for a superseded subscription after switching tasks', () => {
      const { result, rerender } = renderHook(
        ({ taskId }: { taskId: string }) => useSpaceTaskMessages(taskId),
        { initialProps: { taskId: 'task-1' } }
      );
      const firstSubId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [makeRow('m1', 1, 'hello')],
          version: 1,
        });
      });
      expect(result.current.rows).toHaveLength(1);
      rerender({ taskId: 'task-2' });
      expect(result.current.isLoading).toBe(true);
      expect(result.current.rows).toEqual([]);
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [makeRow('stale', 9, 'stale')],
          version: 2,
        });
      });
      expect(result.current.rows).toEqual([]);
      expect(result.current.isLoading).toBe(true);
      const secondSubId = lastMessageSubscribeSubId();
      expect(secondSubId).not.toBe(firstSubId);
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: secondSubId,
          rows: [makeRow('m2', 2, 'fresh')],
          version: 1,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['m2']);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('live delta application', () => {
    it('applies live deltas to the sorted snapshot, merging rows by string id', () => {
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('m2', 2, 'old-2'), makeRow('m1', 1, 'old-1'), makeRow(7, 3, 'numeric')],
          version: 1,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['m1', 'm2', 7]);
      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          removed: [makeRow('m1', 1, 'old-1')],
          updated: [makeRow('m2', 2, 'new-2'), makeRow('7', 3, 'numeric-updated')],
          added: [makeRow('m0', 0, 'new-0')],
          version: 2,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['m0', 'm2', '7']);
      expect(result.current.rows.map((r) => r.content)).toEqual([
        'new-0',
        'new-2',
        'numeric-updated',
      ]);
    });

    it('applies active-turn deltas to the summaries without gating loading', () => {
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const atSub = lastActiveTurnSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', { subscriptionId: atSub, rows: [], version: 1 });
      });
      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: atSub,
          added: [makeActiveTurnRow('sess-1', 10, 'Working')],
          version: 2,
        });
      });
      expect(result.current.activeTurnSummaries).toEqual([
        {
          sessionId: 'sess-1',
          turnIndex: 1,
          entries: [{ kind: 'text', text: 'Working', ts: 10, uuid: 'u-sess-1-10' }],
        },
      ]);
      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('liveQuery.error handling', () => {
    it('resubscribes both queries on a delta-phase error without clearing rows or erroring', () => {
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('m1', 1, 'hello')],
          version: 1,
        });
      });
      expect(subscribeCalls()).toHaveLength(2);
      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'STREAM_LOST',
          message: 'stream lost',
          phase: 'delta',
        });
      });
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.rows.map((r) => r.id)).toEqual(['m1']);
      expect(subscribeCalls()).toHaveLength(4);
      expect(messageSubscribeCalls()[1][1].subscriptionId).toBe(subId);
    });

    it('resets the snapshot retry budget after a delta-phase resubscribe', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'STREAM_LOST',
          message: 'stream lost',
          phase: 'delta',
        });
      });
      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          vi.advanceTimersByTime(2000);
          await Promise.resolve();
        });
      }
      expect(messageSubscribeCalls()).toHaveLength(7);
      expect(result.current.isLoading).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });
      expect(messageSubscribeCalls()).toHaveLength(7);
    });

    it('surfaces a snapshot-phase error while keeping already-loaded rows', () => {
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('m1', 1, 'hello')],
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
      expect(result.current.error).toBe('query failed');
      expect(result.current.isLoading).toBe(false);
      expect(result.current.rows.map((r) => r.id)).toEqual(['m1']);
    });

    it('stops snapshot retries after a snapshot-phase error releases loading', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'QUERY_FAILED',
          message: 'query failed',
          phase: 'snapshot',
        });
      });
      expect(result.current.error).toBe('query failed');
      expect(result.current.isLoading).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });
      expect(messageSubscribeCalls()).toHaveLength(1);
    });

    it('clears active-turn summaries on an active-turn snapshot-phase error', () => {
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const msgSub = lastMessageSubscribeSubId();
      const atSub = lastActiveTurnSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: msgSub,
          rows: [makeRow('m1', 1, 'hello')],
          version: 1,
        });
        fireEvent('liveQuery.snapshot', {
          subscriptionId: atSub,
          rows: [makeActiveTurnRow('sess-1', 10)],
          version: 1,
        });
      });
      expect(result.current.activeTurnSummaries).toHaveLength(1);
      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: atSub,
          code: 'QUERY_FAILED',
          message: 'active turn query failed',
          phase: 'snapshot',
        });
      });
      expect(result.current.error).toBe('active turn query failed');
      expect(result.current.activeTurnSummaries).toEqual([]);
      expect(result.current.rows.map((r) => r.id)).toEqual(['m1']);
      expect(result.current.isLoading).toBe(false);
    });

    it('resubscribes only the active-turn query on an active-turn delta-phase error', () => {
      renderHook(() => useSpaceTaskMessages('task-1'));
      const atSub = lastActiveTurnSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: atSub,
          code: 'STREAM_LOST',
          message: 'stream lost',
          phase: 'delta',
        });
      });
      expect(activeTurnSubscribeCalls()).toHaveLength(2);
      expect(activeTurnSubscribeCalls()[1][1]).toMatchObject({
        queryName: 'spaceTaskActiveTurn.byTask',
        subscriptionId: atSub,
      });
      expect(messageSubscribeCalls()).toHaveLength(1);
    });
  });

  describe('reconnect and cleanup', () => {
    it('clears rows and error while disconnected and reports isReconnecting', () => {
      const { result, rerender } = renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('m1', 1, 'hello')],
          version: 1,
        });
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'QUERY_FAILED',
          message: 'query failed',
          phase: 'snapshot',
        });
      });
      expect(result.current.rows).toHaveLength(1);
      expect(result.current.error).toBe('query failed');
      mockIsConnected.value = false;
      rerender();
      expect(result.current.isReconnecting).toBe(true);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.rows).toEqual([]);
      expect(result.current.error).toBeNull();
    });

    it('subscribes fresh once the connection returns', () => {
      mockIsConnected.value = false;
      const { result, rerender } = renderHook(() => useSpaceTaskMessages('task-1'));
      expect(result.current.isReconnecting).toBe(true);
      expect(subscribeCalls()).toHaveLength(0);
      mockIsConnected.value = true;
      rerender();
      expect(result.current.isReconnecting).toBe(false);
      expect(result.current.isLoading).toBe(true);
      expect(subscribeCalls().map((call) => call[1].queryName)).toEqual([
        'spaceTaskMessages.byTask.compact',
        'spaceTaskActiveTurn.byTask',
      ]);
    });

    it('clears the error and reloads on a hub reconnect while keeping rows', () => {
      let connectionHandler: ((state: string) => void) | null = null;
      mockGetHub.mockReturnValue({
        request: mockRequest,
        onConnection: vi.fn((handler: (state: string) => void) => {
          connectionHandler = handler;
          return () => {};
        }),
      });
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const subId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('m1', 1, 'hello')],
          version: 1,
        });
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'QUERY_FAILED',
          message: 'query failed',
          phase: 'snapshot',
        });
      });
      expect(result.current.error).toBe('query failed');
      act(() => {
        connectionHandler?.('disconnected');
      });
      expect(subscribeCalls()).toHaveLength(2);
      act(() => {
        connectionHandler?.('connected');
      });
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(true);
      expect(result.current.rows.map((r) => r.id)).toEqual(['m1']);
      expect(subscribeCalls()).toHaveLength(4);
      expect(messageSubscribeCalls()[1][1].subscriptionId).toBe(subId);
    });

    it('unsubscribes both queries on unmount and stays inert afterwards', async () => {
      vi.useFakeTimers();
      const { unmount } = renderHook(() => useSpaceTaskMessages('task-1'));
      const msgSub = lastMessageSubscribeSubId();
      const atSub = lastActiveTurnSubscribeSubId();
      await act(async () => {
        await Promise.resolve();
      });
      unmount();
      const unsubCalls = unsubscribeCalls();
      expect(unsubCalls).toHaveLength(2);
      expect(unsubCalls.map((call) => call[1].subscriptionId).sort()).toEqual(
        [atSub, msgSub].sort()
      );
      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(2);
      fireEvent('liveQuery.snapshot', {
        subscriptionId: msgSub,
        rows: [makeRow('late', 1, 'late')],
        version: 2,
      });
      fireEvent('liveQuery.delta', {
        subscriptionId: msgSub,
        added: [makeRow('late-2', 2, 'late')],
        version: 3,
      });
      fireEvent('liveQuery.error', {
        subscriptionId: msgSub,
        code: 'LATE',
        message: 'late',
        phase: 'delta',
      });
      expect(subscribeCalls()).toHaveLength(2);
    });
  });
});
