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

function makeRow(id: string, createdAt: number) {
  return {
    id,
    taskId: 'task-1',
    label: `milestone-${id}`,
    state: 'done',
    createdAt,
  } as never;
}

import { useTaskMilestones } from '../useTaskMilestones';

describe('useTaskMilestones liveQuery lifecycle', () => {
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
      const { result } = renderHook(() => useTaskMilestones({ taskId: 'task-1' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(1);
      expect(subscribeCalls()[0][1]).toMatchObject({
        queryName: 'taskMilestones.byTask',
        params: ['task-1'],
      });
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
      const { result } = renderHook(() => useTaskMilestones({ taskId: 'task-1' }));
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
          rows: [makeRow('ms1', 1)],
          version: 1,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['ms1']);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('liveQuery.error handling', () => {
    it('registers no liveQuery.error listener at all', () => {
      renderHook(() => useTaskMilestones({ taskId: 'task-1' }));
      const methods = mockOnEvent.mock.calls.map((call) => call[0]);
      expect(methods).toEqual(['liveQuery.snapshot', 'liveQuery.delta']);
    });

    it('ignores a delta-phase error without resubscribing and keeps rows', async () => {
      const { result } = renderHook(() => useTaskMilestones({ taskId: 'task-1' }));
      const subId = subscribeCalls()[0][1].subscriptionId;
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('ms1', 1)],
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
      expect(subscribeCalls()).toHaveLength(1);
      expect(result.current.rows.map((r) => r.id)).toEqual(['ms1']);
      expect(result.current.isLoading).toBe(false);
    });

    it('ignores a snapshot-phase error while awaiting so loading stays claimed', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useTaskMilestones({ taskId: 'task-1' }));
      const subId = subscribeCalls()[0][1].subscriptionId;
      act(() => {
        fireEvent('liveQuery.error', {
          subscriptionId: subId,
          code: 'QUERY_FAILED',
          message: 'query failed',
          phase: 'snapshot',
        });
      });
      expect(result.current.isLoading).toBe(true);
      expect(result.current.rows).toEqual([]);
      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(1);
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('ms1', 1)],
          version: 1,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['ms1']);
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
      const { result } = renderHook(() => useTaskMilestones({ taskId: 'task-1' }));
      const subId = subscribeCalls()[0][1].subscriptionId;
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('ms1', 1)],
          version: 1,
        });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['ms1']);
      await act(async () => {
        connectionHandler?.('disconnected');
        connectionHandler?.('connected');
        await Promise.resolve();
      });
      expect(subscribeCalls()).toHaveLength(2);
      expect(subscribeCalls()[1][1].subscriptionId).toBe(subId);
      expect(result.current.rows.map((r) => r.id)).toEqual(['ms1']);
      expect(result.current.isLoading).toBe(true);
    });

    it('clears rows while disconnected and reports isReconnecting', () => {
      const { result, rerender } = renderHook(() => useTaskMilestones({ taskId: 'task-1' }));
      const subId = subscribeCalls()[0][1].subscriptionId;
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeRow('ms1', 1)],
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

    it('does nothing without a task id', () => {
      const { result } = renderHook(() => useTaskMilestones({ taskId: null }));
      expect(subscribeCalls()).toHaveLength(0);
      expect(result.current.rows).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isReconnecting).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('unsubscribes on unmount and stays inert afterwards', async () => {
      vi.useFakeTimers();
      const { unmount } = renderHook(() => useTaskMilestones({ taskId: 'task-1' }));
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
        rows: [makeRow('late', 1)],
        version: 2,
      });
      fireEvent('liveQuery.delta', {
        subscriptionId: subId,
        added: [makeRow('late-2', 2)],
        version: 3,
      });
      expect(subscribeCalls()).toHaveLength(1);
    });
  });
});
