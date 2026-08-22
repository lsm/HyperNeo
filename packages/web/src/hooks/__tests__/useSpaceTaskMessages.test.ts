import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/preact';

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

function lastMessageSubscribeSubId(): string {
  const calls = subscribeCalls().filter((call) =>
    String(call[1].queryName).startsWith('spaceTaskMessages.')
  );
  return calls[calls.length - 1][1].subscriptionId;
}

function lastActiveTurnSubscribeSubId(): string {
  const calls = subscribeCalls().filter(
    (call) => call[1].queryName === 'spaceTaskActiveTurn.byTask'
  );
  return calls[calls.length - 1][1].subscriptionId;
}

import { useSpaceTaskMessages, sortActiveTurnRows, sortRows } from '../useSpaceTaskMessages';

describe('sortRows', () => {
  it('breaks same-millisecond ties by insOrder (insertion), not the UUID id (#2338)', () => {
    const make = (id: string, insOrder: number) =>
      ({
        id,
        sessionId: 's',
        kind: 'task_agent',
        role: 'user',
        label: '',
        taskId: 't',
        taskTitle: '',
        messageType: 'user',
        content: '',
        createdAt: 1000,
        insOrder,
      }) as never;
    const sorted = sortRows([make('zzz', 1), make('aaa', 2)]);
    expect(sorted.map((r) => r.id)).toEqual(['zzz', 'aaa']);
  });

  it('falls back to the UUID id tiebreak when insOrder is absent (full feed)', () => {
    const make = (id: string) =>
      ({
        id,
        sessionId: 's',
        kind: 'task_agent',
        role: 'user',
        label: '',
        taskId: 't',
        taskTitle: '',
        messageType: 'user',
        content: '',
        createdAt: 1000,
      }) as never;
    const sorted = sortRows([make('zzz'), make('aaa')]);
    expect(sorted.map((r) => r.id)).toEqual(['aaa', 'zzz']);
  });
});

describe('sortActiveTurnRows', () => {
  it('breaks same-timestamp ties by numeric rowid, not lexicographic id', () => {
    const make = (rowId: number, blockIdx: number) =>
      ({
        id: `space:test:task:sess:1:${rowId}:${blockIdx}`,
        sessionId: 'space:test:task:sess',
        ts: 1000,
      }) as never;
    const sorted = sortActiveTurnRows([make(10, -2), make(9, 0), make(2, 0), make(11, -1)]);
    expect(sorted.map((r) => r.id)).toEqual([
      'space:test:task:sess:1:2:0',
      'space:test:task:sess:1:9:0',
      'space:test:task:sess:1:10:-2',
      'space:test:task:sess:1:11:-1',
    ]);
  });
});

describe('useSpaceTaskMessages', () => {
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

  it('subscribes to compact messages and active-turn queries by default', () => {
    renderHook(() => useSpaceTaskMessages('task-abc'));

    expect(subscribeCalls().map((call) => call[1].queryName)).toEqual([
      'spaceTaskMessages.byTask.compact',
      'spaceTaskActiveTurn.byTask',
    ]);
    expect(subscribeCalls()[0][1]).toMatchObject({
      queryName: 'spaceTaskMessages.byTask.compact',
      params: ['task-abc'],
    });
    expect(subscribeCalls()[1][1]).toMatchObject({
      queryName: 'spaceTaskActiveTurn.byTask',
      params: ['task-abc'],
    });
  });

  it('subscribes to the compact query name when variant="compact"', () => {
    renderHook(() => useSpaceTaskMessages('task-abc', 'compact'));

    expect(subscribeCalls().map((call) => call[1].queryName)).toEqual([
      'spaceTaskMessages.byTask.compact',
      'spaceTaskActiveTurn.byTask',
    ]);
  });

  it('subscribes to the legacy full query name when variant="full"', () => {
    renderHook(() => useSpaceTaskMessages('task-abc', 'full'));

    expect(subscribeCalls()).toHaveLength(1);
    expect(subscribeCalls()[0][1]).toMatchObject({
      queryName: 'spaceTaskMessages.byTask',
      params: ['task-abc'],
    });
  });

  it('does not subscribe when taskId is null', () => {
    renderHook(() => useSpaceTaskMessages(null));

    const subscribe = mockRequest.mock.calls.find(([method]) => method === 'liveQuery.subscribe');
    expect(subscribe).toBeUndefined();
  });

  it('builds active-turn summaries from the separate active-turn query', () => {
    const { result } = renderHook(() => useSpaceTaskMessages('task-abc'));
    const messageSubId = lastMessageSubscribeSubId();
    const activeTurnSubId = lastActiveTurnSubscribeSubId();

    act(() => {
      fireEvent('liveQuery.snapshot', {
        subscriptionId: messageSubId,
        rows: [],
        version: 1,
      });
      fireEvent('liveQuery.snapshot', {
        subscriptionId: activeTurnSubId,
        rows: [
          {
            id: 'sess-1:1:row-1:0',
            sessionId: 'sess-1',
            turnIndex: 1,
            ts: 10,
            entry: { kind: 'text', text: 'Working', ts: 10, uuid: 'u1' },
          },
        ],
        version: 1,
      });
    });

    expect(result.current.activeTurnSummaries).toEqual([
      {
        sessionId: 'sess-1',
        turnIndex: 1,
        entries: [{ kind: 'text', text: 'Working', ts: 10, uuid: 'u1' }],
      },
    ]);
  });

  it('keeps an active-turn snapshot-phase error while message events keep flowing', () => {
    const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
    const messageSubId = lastMessageSubscribeSubId();
    const activeTurnSubId = lastActiveTurnSubscribeSubId();

    act(() => {
      fireEvent('liveQuery.snapshot', {
        subscriptionId: messageSubId,
        rows: [{ id: 'msg-1', taskId: 'task-1', createdAt: 1 }],
        version: 1,
      });
      fireEvent('liveQuery.error', {
        subscriptionId: activeTurnSubId,
        code: 'QUERY_FAILED',
        message: 'active turn query failed',
        phase: 'snapshot',
      });
    });
    expect(result.current.error).toBe('active turn query failed');

    act(() => {
      fireEvent('liveQuery.delta', {
        subscriptionId: messageSubId,
        added: [{ id: 'msg-2', taskId: 'task-1', createdAt: 2 }],
        version: 2,
      });
    });
    expect(result.current.error).toBe('active turn query failed');
    expect(result.current.rows.map((r) => r.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('ignores a stale active-turn subscribe rejection after switching tasks', async () => {
    let rejectStale: (reason: Error) => void = () => {};
    const staleRejection = new Promise<void>((_, reject) => {
      rejectStale = reject;
    });
    mockRequest.mockImplementation(
      (method: string, payload: { queryName?: string; subscriptionId?: string }) => {
        if (
          method === 'liveQuery.subscribe' &&
          payload.queryName === 'spaceTaskActiveTurn.byTask' &&
          String(payload.subscriptionId).includes('task-1')
        ) {
          return staleRejection;
        }
        return Promise.resolve(undefined);
      }
    );

    const { result, rerender } = renderHook(
      ({ taskId }: { taskId: string }) => useSpaceTaskMessages(taskId),
      { initialProps: { taskId: 'task-1' } }
    );
    rerender({ taskId: 'task-2' });
    const messageSubId = lastMessageSubscribeSubId();
    const activeTurnSubId = lastActiveTurnSubscribeSubId();
    act(() => {
      fireEvent('liveQuery.snapshot', { subscriptionId: messageSubId, rows: [], version: 1 });
      fireEvent('liveQuery.snapshot', {
        subscriptionId: activeTurnSubId,
        rows: [
          {
            id: 'sess-1:1:row-1:0',
            sessionId: 'sess-1',
            turnIndex: 1,
            ts: 10,
            entry: { kind: 'text', text: 'Working', ts: 10, uuid: 'u1' },
          },
        ],
        version: 1,
      });
    });
    expect(result.current.activeTurnSummaries).toHaveLength(1);

    await act(async () => {
      rejectStale(new Error('stale rejection'));
      await Promise.resolve();
    });
    expect(result.current.activeTurnSummaries).toHaveLength(1);
  });

  describe('isLoading (empty-state flash prevention)', () => {
    it('reports isLoading=true on the very first render when a taskId is provided', () => {
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));

      expect(result.current.isLoading).toBe(true);
      expect(result.current.rows).toEqual([]);
    });

    it('reports isLoading=false when no taskId is provided', () => {
      const { result } = renderHook(() => useSpaceTaskMessages(null));

      expect(result.current.isLoading).toBe(false);
    });

    it('flips isLoading to false once the LiveQuery snapshot arrives', () => {
      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));

      const subId = lastMessageSubscribeSubId();
      expect(result.current.isLoading).toBe(true);

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [],
          version: 1,
        });
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('stays isLoading=true after switching taskId until the new snapshot arrives', () => {
      const { result, rerender } = renderHook(
        ({ taskId }: { taskId: string }) => useSpaceTaskMessages(taskId),
        { initialProps: { taskId: 'task-1' } }
      );

      const firstSubId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [],
          version: 1,
        });
      });
      expect(result.current.isLoading).toBe(false);

      rerender({ taskId: 'task-2' });
      expect(result.current.isLoading).toBe(true);

      const secondSubId = lastMessageSubscribeSubId();
      expect(secondSubId).not.toBe(firstSubId);
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: secondSubId,
          rows: [],
          version: 1,
        });
      });
      expect(result.current.isLoading).toBe(false);
    });

    it('releases the loading gate on subscribe failure', async () => {
      mockRequest.mockRejectedValueOnce(new Error('subscribe failed'));

      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('re-subscribes and waits for a fresh snapshot after reconnect', () => {
      let connectionHandler: ((state: string) => void) | null = null;
      mockGetHub.mockReturnValue({
        request: mockRequest,
        onConnection: vi.fn((handler: (state: string) => void) => {
          connectionHandler = handler;
          return () => {};
        }),
      });

      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const firstSubId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [{ id: 'msg-1', taskId: 'task-1', createdAt: 1 }],
          version: 1,
        });
      });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.rows).toHaveLength(1);

      act(() => {
        connectionHandler?.('connected');
      });

      expect(subscribeCalls()).toHaveLength(4);
      expect(result.current.isLoading).toBe(true);
      expect(result.current.rows).toHaveLength(1);

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [{ id: 'msg-1', taskId: 'task-1', createdAt: 1 }],
          version: 2,
        });
      });
      expect(result.current.isLoading).toBe(false);
    });

    it('retries a reconnect subscribe when the server acks without a snapshot', async () => {
      vi.useFakeTimers();
      let connectionHandler: ((state: string) => void) | null = null;
      mockGetHub.mockReturnValue({
        request: mockRequest,
        onConnection: vi.fn((handler: (state: string) => void) => {
          connectionHandler = handler;
          return () => {};
        }),
      });

      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const firstSubId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [{ id: 'msg-1', taskId: 'task-1', createdAt: 1 }],
          version: 1,
        });
      });

      act(() => {
        connectionHandler?.('connected');
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isLoading).toBe(true);
      expect(subscribeCalls()).toHaveLength(4);

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(subscribeCalls()).toHaveLength(6);

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [{ id: 'msg-1', taskId: 'task-1', createdAt: 1 }],
          version: 2,
        });
      });
      expect(result.current.isLoading).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(subscribeCalls()).toHaveLength(6);
    });

    it('releases loading after reconnect snapshot retries are exhausted', async () => {
      vi.useFakeTimers();
      let connectionHandler: ((state: string) => void) | null = null;
      mockGetHub.mockReturnValue({
        request: mockRequest,
        onConnection: vi.fn((handler: (state: string) => void) => {
          connectionHandler = handler;
          return () => {};
        }),
      });

      const { result } = renderHook(() => useSpaceTaskMessages('task-1'));
      const firstSubId = lastMessageSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [{ id: 'msg-1', taskId: 'task-1', createdAt: 1 }],
          version: 1,
        });
      });

      act(() => {
        connectionHandler?.('connected');
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isLoading).toBe(true);

      for (let i = 0; i < 5; i += 1) {
        await act(async () => {
          await Promise.resolve();
          vi.advanceTimersByTime(2000);
          await Promise.resolve();
        });
      }

      expect(subscribeCalls()).toHaveLength(14);
      expect(result.current.isLoading).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(subscribeCalls()).toHaveLength(14);
    });
  });
});
