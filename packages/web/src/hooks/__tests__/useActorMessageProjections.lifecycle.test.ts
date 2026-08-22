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

function unsubscribeCalls() {
  return mockRequest.mock.calls.filter((call) => call[0] === 'liveQuery.unsubscribe');
}

function makeRow(id: string, createdAt: number, summary = '') {
  return {
    id,
    scope: 'task_timeline',
    eventKind: 'answer',
    from: { kind: 'worker', label: 'Coder' },
    title: 'Answer',
    summary,
    createdAt,
  } as never;
}

import { useActorMessageProjections } from '../useActorMessageProjections';

describe('useActorMessageProjections liveQuery lifecycle', () => {
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

  describe('snapshot retry behavior', () => {
    it('never retries while a snapshot fails to arrive', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() =>
        useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' })
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(1);
      expect(result.current.isLoading).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(1);
      expect(result.current.isLoading).toBe(true);
    });

    it('releases loading when the subscribe request rejects without retrying and still accepts a late snapshot', async () => {
      vi.useFakeTimers();
      mockRequest.mockRejectedValueOnce(new Error('subscribe failed'));
      const { result } = renderHook(() =>
        useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' })
      );
      const subId = subscribeCalls()[0][1].subscriptionId;
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.rows).toEqual([]);
      expect('error' in result.current).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(1);
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('r1', 1, 'late')],
          version: 1,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['r1']);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('liveQuery.error handling', () => {
    it('resubscribes with the same subscription id on a delta-phase error keeping rows', async () => {
      const { result } = renderHook(() =>
        useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' })
      );
      const subId = subscribeCalls()[0][1].subscriptionId;
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('r1', 1, 'hello')],
          version: 1,
        });
      });
      expect(result.current.isLoading).toBe(false);
      await act(async () => {
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'STREAM_LOST',
          message: 'stream lost',
          phase: 'delta',
        });
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(2);
      expect(subscribeCalls()[1][1].subscriptionId).toBe(subId);
      expect(subscribeCalls()[1][1]).toMatchObject({
        queryName: 'actorMessages.byTask',
        params: ['task-1'],
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['r1']);
      expect(result.current.isLoading).toBe(false);
      expect('error' in result.current).toBe(false);
    });

    it('applies a snapshot racing the delta-phase resubscribe before it resolves', async () => {
      const { result } = renderHook(() =>
        useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' })
      );
      const subId = subscribeCalls()[0][1].subscriptionId;
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('r1', 1, 'hello')],
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
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('r2', 2, 'raced')],
          version: 2,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['r2']);
    });

    it('releases loading on a snapshot-phase error without surfacing an error and revives on a late snapshot', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() =>
        useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' })
      );
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
      expect(result.current.rows).toEqual([]);
      expect('error' in result.current).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(10000);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(1);
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('r1', 1, 'revived')],
          version: 1,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['r1']);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('reconnect and disconnect', () => {
    it('resubscribes on a hub reconnect keeping rows and reloading', async () => {
      let connectionHandler: ((state: string) => void) | null = null;
      mockGetHub.mockReturnValue({
        request: mockRequest,
        onConnection: vi.fn((handler: (state: string) => void) => {
          connectionHandler = handler;
          return () => {};
        }),
      });
      const { result } = renderHook(() =>
        useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' })
      );
      const subId = subscribeCalls()[0][1].subscriptionId;
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('r1', 1, 'hello')],
          version: 1,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['r1']);
      await act(async () => {
        connectionHandler?.('disconnected');
        connectionHandler?.('connected');
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(2);
      expect(subscribeCalls()[1][1].subscriptionId).toBe(subId);
      expect(result.current.rows.map((r) => r.id)).toEqual(['r1']);
      expect(result.current.isLoading).toBe(true);
    });

    it('clears rows while disconnected and reports isReconnecting', async () => {
      const { result, rerender } = renderHook(() =>
        useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' })
      );
      const subId = subscribeCalls()[0][1].subscriptionId;
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('r1', 1, 'hello')],
          version: 1,
        });
      });
      expect(result.current.rows).toHaveLength(1);
      mockIsConnected.value = false;
      rerender();
      expect(result.current.isReconnecting).toBe(true);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.rows).toEqual([]);
    });
  });

  describe('cleanup', () => {
    it('unsubscribes on unmount and stays inert afterwards', async () => {
      vi.useFakeTimers();
      const { unmount } = renderHook(() =>
        useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' })
      );
      const subId = subscribeCalls()[0][1].subscriptionId;
      await act(async () => {
        await Promise.resolve();
      });
      unmount();
      expect(unsubscribeCalls()).toEqual([['liveQuery.unsubscribe', { subscriptionId: subId }]]);
      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(1);
      fireEvent('liveQuery.snapshot', {
        subscriptionId: subId,
        rows: [makeRow('late', 1, 'late')],
        version: 2,
      });
      fireEvent('liveQuery.delta', {
        subscriptionId: subId,
        added: [makeRow('late-2', 2, 'late')],
        version: 3,
      });
      fireEvent('liveQuery.error', {
        subscriptionId: subId,
        code: 'LATE',
        message: 'late',
        phase: 'delta',
      });
      expect(subscribeCalls()).toHaveLength(1);
    });
  });
});
