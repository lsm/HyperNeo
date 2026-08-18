import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';

const { mockRequest, mockOnEvent, mockIsConnected } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockOnEvent: vi.fn(),
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

import {
  useGroupMessages,
  generateGroupMessagesSubId,
  resetSubscriptionCounterForTesting,
  type SessionGroupMessage,
} from '../useGroupMessages';

function makeMessage(id: number, content = `msg-${id}`): SessionGroupMessage {
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

function makeChild(subId: number, parentToolUseId: string): SessionGroupMessage {
  return {
    id: `child-${subId}`,
    groupId: 'group-1',
    sessionId: null,
    role: 'assistant',
    messageType: 'text',
    content: `child-${subId}`,
    createdAt: 2_000_000 + subId,
    parentToolUseId,
  };
}

type EventHandler = (event: unknown) => void;
let eventHandlers: Record<string, EventHandler[]> = {};

function fireEvent(method: string, payload: unknown): void {
  (eventHandlers[method] ?? []).forEach((h) => h(payload));
}

function lastSubscribeSubId(): string {
  const subscribeCalls = mockRequest.mock.calls.filter((call) => call[0] === 'liveQuery.subscribe');
  return subscribeCalls[subscribeCalls.length - 1][1].subscriptionId;
}

beforeEach(() => {
  vi.resetAllMocks();
  resetSubscriptionCounterForTesting();
  mockIsConnected.value = true;
  eventHandlers = {};

  mockRequest.mockResolvedValue({ ok: true });

  mockOnEvent.mockImplementation((method: string, handler: EventHandler) => {
    if (!eventHandlers[method]) eventHandlers[method] = [];
    eventHandlers[method].push(handler);
    return () => {
      eventHandlers[method] = (eventHandlers[method] ?? []).filter((h) => h !== handler);
    };
  });
});

describe('useGroupMessages', () => {
  describe('initial state', () => {
    it('returns empty messages and isLoading=false when groupId is null', () => {
      const { result } = renderHook(() => useGroupMessages(null));

      expect(result.current.messages).toEqual([]);
      expect(result.current.isLoading).toBe(false);
    });

    it('sets isLoading=true immediately when groupId is provided', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      expect(result.current.isLoading).toBe(true);
      expect(result.current.messages).toEqual([]);
    });

    it('calls liveQuery.subscribe with correct params on mount', () => {
      renderHook(() => useGroupMessages('group-abc'));

      expect(mockRequest).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'sessionGroupMessages.byGroup',
        params: ['group-abc'],
        subscriptionId: expect.stringContaining('group-abc'),
      });
    });

    it('does not subscribe when not connected', () => {
      mockIsConnected.value = false;

      renderHook(() => useGroupMessages('group-1'));

      const subscribeCalls = mockRequest.mock.calls.filter(
        (call) => call[0] === 'liveQuery.subscribe'
      );
      expect(subscribeCalls).toHaveLength(0);
    });
  });

  describe('snapshot handling', () => {
    it('replaces messages and clears isLoading on snapshot', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      const subId = lastSubscribeSubId();
      const rows = [makeMessage(1), makeMessage(2)];

      act(() => {
        fireEvent('liveQuery.snapshot', { subscriptionId: subId, rows, version: 1 });
      });

      expect(result.current.messages).toEqual(rows);
      expect(result.current.isLoading).toBe(false);
    });

    it('discards snapshot with a stale subscriptionId', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: 'stale-sub-id-9999',
          rows: [makeMessage(99)],
          version: 1,
        });
      });

      expect(result.current.messages).toEqual([]);
    });
  });

  describe('delta handling', () => {
    it('appends added messages from delta', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          added: [makeMessage(2)],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[1].id).toBe(2);
    });

    it('appends multiple added messages from a single delta', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [],
          version: 1,
        });
      });

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          added: [makeMessage(1), makeMessage(2), makeMessage(3)],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(3);
    });

    it('applies removed entries from delta', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2)],
          version: 1,
        });
      });

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          removed: [makeMessage(1)],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe(2);
    });

    it('applies updated entries from delta', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });

      const updatedMsg = { ...makeMessage(1), content: 'updated content' };
      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          updated: [updatedMsg],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe('updated content');
    });

    it('ignores delta with empty added array', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          added: [],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(1);
    });

    it('discards delta with stale subscriptionId', () => {
      const { result } = renderHook(() => useGroupMessages('group-1'));

      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: 'stale-delta-sub-9999',
          added: [makeMessage(99)],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe(1);
    });
  });

  describe('stale-event guard (rapid task switching)', () => {
    it('discards snapshot from previous groupId after switching', () => {
      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' } }
      );

      const firstSubId = lastSubscribeSubId();

      rerender({ groupId: 'group-2' });

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [makeMessage(99)],
          version: 1,
        });
      });

      expect(result.current.messages).toEqual([]);
    });

    it('accepts snapshot from current groupId after switching', () => {
      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' } }
      );

      rerender({ groupId: 'group-2' });

      const group2Call = mockRequest.mock.calls.find(
        (call) => call[0] === 'liveQuery.subscribe' && call[1]?.params?.[0] === 'group-2'
      );
      expect(group2Call).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const secondSubId = group2Call![1].subscriptionId as string;

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: secondSubId,
          rows: [makeMessage(5)],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe(5);
    });

    it('reports isLoading=true on the render following a groupId switch', () => {
      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' as string | null } }
      );

      const firstSubId = lastSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });
      expect(result.current.isLoading).toBe(false);

      rerender({ groupId: 'group-2' });
      expect(result.current.isLoading).toBe(true);
      expect(result.current.messages).toEqual([]);
    });
  });

  describe('reconnect handling', () => {
    it('re-subscribes and refreshes messages after WebSocket reconnect', () => {
      const { result, rerender } = renderHook(
        ({ isConn }: { isConn: boolean }) => {
          mockIsConnected.value = isConn;
          return useGroupMessages('group-1');
        },
        { initialProps: { isConn: true } }
      );

      const firstSubId = lastSubscribeSubId();
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

      act(() => {
        rerender({ isConn: true });
      });

      const reconnectSubId = lastSubscribeSubId();
      expect(reconnectSubId).not.toBe(firstSubId);

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: reconnectSubId,
          rows: [makeMessage(1), makeMessage(2)],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(2);
    });

    it('discards events from the pre-reconnect subscription after reconnect', () => {
      const { result, rerender } = renderHook(
        ({ isConn }: { isConn: boolean }) => {
          mockIsConnected.value = isConn;
          return useGroupMessages('group-1');
        },
        { initialProps: { isConn: true } }
      );

      const firstSubId = lastSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });

      act(() => {
        rerender({ isConn: false });
      });
      act(() => {
        rerender({ isConn: true });
      });

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

  describe('cleanup', () => {
    it('calls liveQuery.unsubscribe on unmount', () => {
      const { unmount } = renderHook(() => useGroupMessages('group-1'));

      const subId = lastSubscribeSubId();

      unmount();

      expect(mockRequest).toHaveBeenCalledWith('liveQuery.unsubscribe', {
        subscriptionId: subId,
      });
    });

    it('unsubscribes from previous group when groupId changes', () => {
      const { rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' } }
      );

      const firstSubId = mockRequest.mock.calls[0][1].subscriptionId;

      rerender({ groupId: 'group-2' });

      expect(mockRequest).toHaveBeenCalledWith('liveQuery.unsubscribe', {
        subscriptionId: firstSubId,
      });
    });

    it('removes event listeners on unmount', () => {
      const { unmount } = renderHook(() => useGroupMessages('group-1'));

      unmount();

      expect(eventHandlers['liveQuery.snapshot'] ?? []).toHaveLength(0);
      expect(eventHandlers['liveQuery.delta'] ?? []).toHaveLength(0);
    });

    it('clears messages and stops loading when groupId becomes null', () => {
      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' as string | null } }
      );

      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(1);

      rerender({ groupId: null });

      expect(result.current.messages).toEqual([]);
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('subscribe error handling', () => {
    it('clears isLoading after all retries are exhausted', async () => {
      vi.useFakeTimers();
      mockRequest.mockRejectedValue(new Error('subscribe failed'));

      const { result } = renderHook(() => useGroupMessages('group-1'));

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(result.current.isLoading).toBe(false);

      vi.useRealTimers();
    });

    it('succeeds on retry after initial subscribe failure', async () => {
      vi.useFakeTimers();

      mockRequest
        .mockRejectedValueOnce(new Error('first attempt failed'))
        .mockResolvedValue({ ok: true });

      const { result } = renderHook(() => useGroupMessages('group-1'));

      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });

      expect(result.current.isLoading).toBe(true);

      const subId = lastSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.isLoading).toBe(false);

      vi.useRealTimers();
    });

    it('does not clear isLoading after error if groupId already changed', async () => {
      vi.useFakeTimers();

      let rejectSubscribe: (err: Error) => void;
      mockRequest.mockReturnValueOnce(
        new Promise<never>((_, reject) => {
          rejectSubscribe = reject;
        })
      );
      mockRequest.mockResolvedValue({ ok: true });

      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' } }
      );

      rerender({ groupId: 'group-2' });

      await act(async () => {
        rejectSubscribe(new Error('late failure'));
        await Promise.resolve();
      });

      expect(result.current.isLoading).toBe(true);

      vi.useRealTimers();
    });

    it('cancels pending retry when groupId changes', async () => {
      vi.useFakeTimers();

      mockRequest.mockRejectedValueOnce(new Error('fail'));
      mockRequest.mockResolvedValue({ ok: true });

      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' } }
      );

      await act(async () => {
        await Promise.resolve();
      });

      rerender({ groupId: 'group-2' });

      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });

      const group2Calls = mockRequest.mock.calls.filter(
        (call) => call[0] === 'liveQuery.subscribe' && call[1]?.params?.[0] === 'group-2'
      );
      expect(group2Calls).toHaveLength(1);

      expect(result.current.isLoading).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('isReconnecting state', () => {
    it('is false when connected with a groupId', () => {
      mockIsConnected.value = true;
      const { result } = renderHook(() => useGroupMessages('group-1'));
      expect(result.current.isReconnecting).toBe(false);
    });

    it('is false when groupId is null regardless of connection state', () => {
      mockIsConnected.value = false;
      const { result } = renderHook(() => useGroupMessages(null));
      expect(result.current.isReconnecting).toBe(false);
    });

    it('is true when disconnected but groupId is set', () => {
      const { result, rerender } = renderHook(
        ({ isConn }: { isConn: boolean }) => {
          mockIsConnected.value = isConn;
          return useGroupMessages('group-1');
        },
        { initialProps: { isConn: true } }
      );

      expect(result.current.isReconnecting).toBe(false);

      act(() => {
        rerender({ isConn: false });
      });

      expect(result.current.isReconnecting).toBe(true);
    });

    it('transitions back to false once reconnected', () => {
      const { result, rerender } = renderHook(
        ({ isConn }: { isConn: boolean }) => {
          mockIsConnected.value = isConn;
          return useGroupMessages('group-1');
        },
        { initialProps: { isConn: true } }
      );

      act(() => rerender({ isConn: false }));
      expect(result.current.isReconnecting).toBe(true);

      act(() => rerender({ isConn: true }));
      expect(result.current.isReconnecting).toBe(false);
    });
  });

  describe('subagent block pagination', () => {
    it('counts subagent blocks as 1 top-level unit: 20 TL + 1 parent + 70 children all visible with pageSize=50', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 50 }));
      const subId = lastSubscribeSubId();

      const topLevel = Array.from({ length: 20 }, (_, i) => makeMessage(i + 1));
      const parent = makeMessage(21);
      const children = Array.from({ length: 70 }, (_, i) => makeChild(i + 1, 'tool-use-id-21'));

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [...topLevel, parent, ...children],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(91);
      expect(result.current.hasOlder).toBe(false);
    });

    it('subagent block never split: parent and all children always shown together', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 50 }));
      const subId = lastSubscribeSubId();

      const topLevel = Array.from({ length: 55 }, (_, i) => makeMessage(i + 1));
      const parent = makeMessage(56);
      const children = Array.from({ length: 10 }, (_, i) => makeChild(i + 1, 'tool-use-id-56'));

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [...topLevel, parent, ...children],
          version: 1,
        });
      });

      expect(result.current.hasOlder).toBe(true);
      expect(result.current.messages).toHaveLength(60);
      expect(result.current.messages.some((m) => m.id === 56)).toBe(true);
      const visibleChildIds = result.current.messages
        .filter((m) => (m as SessionGroupMessage).parentToolUseId === 'tool-use-id-56')
        .map((m) => m.id);
      expect(visibleChildIds).toHaveLength(10);
    });

    it('loadEarlier reveals top-level messages and their children together', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 3 }));
      const subId = lastSubscribeSubId();

      const topLevel = Array.from({ length: 4 }, (_, i) => makeMessage(i + 1));
      const parent = makeMessage(5);
      const children = Array.from({ length: 5 }, (_, i) => makeChild(i + 1, 'tool-use-id-5'));

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [...topLevel, parent, ...children],
          version: 1,
        });
      });

      expect(result.current.hasOlder).toBe(true);
      expect(result.current.messages).toHaveLength(8);

      act(() => {
        result.current.loadEarlier();
      });

      expect(result.current.messages).toHaveLength(10);
      expect(result.current.hasOlder).toBe(false);
    });

    it('does not crash when a combined removed+added delta removes all visible messages', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 1 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3)],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe(3);

      const newMsg = makeMessage(4);
      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          removed: [makeMessage(3)],
          added: [newMsg],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe(4);
    });

    it('delta-added child with createdAt in hidden region is placed in hidden region, not visible window', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 2 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4), makeMessage(5)],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].id).toBe(4);
      expect(result.current.messages[1].id).toBe(5);

      const lateChild: SessionGroupMessage = {
        id: 'late-child',
        groupId: 'group-1',
        sessionId: null,
        role: 'assistant',
        messageType: 'text',
        content: 'late-child',
        createdAt: 1_000_002,
        parentToolUseId: 'tool-use-id-2',
      };

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          added: [lateChild],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].id).toBe(4);
      expect(result.current.messages[1].id).toBe(5);
      expect(result.current.hasOlder).toBe(true);
    });

    it('hasOlder is false when all messages are subagent children of a single visible parent', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 5 }));
      const subId = lastSubscribeSubId();

      const parent = makeMessage(1);
      const children = Array.from({ length: 20 }, (_, i) => makeChild(i + 1, 'tool-use-id-1'));

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [parent, ...children],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(21);
      expect(result.current.hasOlder).toBe(false);
    });
  });

  describe('generateGroupMessagesSubId', () => {
    it('includes the groupId in the subscription ID', () => {
      const id = generateGroupMessagesSubId('my-group');
      expect(id).toContain('my-group');
    });

    it('generates unique IDs for successive calls', () => {
      const id1 = generateGroupMessagesSubId('g');
      const id2 = generateGroupMessagesSubId('g');
      expect(id1).not.toBe(id2);
    });

    it('counter resets between tests via resetSubscriptionCounterForTesting', () => {
      const id = generateGroupMessagesSubId('g');
      expect(id).toBe('group-messages-g-1');
    });
  });

  describe('pagination (hasOlder / loadEarlier)', () => {
    it('hasOlder is false when snapshot has fewer messages than pageSize', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 5 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3)],
          version: 1,
        });
      });

      expect(result.current.hasOlder).toBe(false);
      expect(result.current.messages).toHaveLength(3);
    });

    it('hasOlder is false when snapshot has exactly pageSize messages', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 3 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3)],
          version: 1,
        });
      });

      expect(result.current.hasOlder).toBe(false);
      expect(result.current.messages).toHaveLength(3);
    });

    it('hasOlder is true when snapshot has more messages than pageSize', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 2 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4), makeMessage(5)],
          version: 1,
        });
      });

      expect(result.current.hasOlder).toBe(true);
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].id).toBe(4);
      expect(result.current.messages[1].id).toBe(5);
    });

    it('loadEarlier reveals the previous page of messages', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 2 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4), makeMessage(5)],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.hasOlder).toBe(true);

      act(() => {
        result.current.loadEarlier();
      });

      expect(result.current.messages).toHaveLength(4);
      expect(result.current.messages[0].id).toBe(2);
      expect(result.current.messages[3].id).toBe(5);
    });

    it('loadEarlier clamps to 0 — cannot hide negative messages', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 3 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4), makeMessage(5)],
          version: 1,
        });
      });

      act(() => {
        result.current.loadEarlier();
      });

      expect(result.current.messages).toHaveLength(5);
      expect(result.current.hasOlder).toBe(false);

      act(() => {
        result.current.loadEarlier();
      });

      expect(result.current.messages).toHaveLength(5);
    });

    it('new delta messages are always visible regardless of hiddenOlderCount', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 2 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4), makeMessage(5)],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(2);

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          added: [makeMessage(6)],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(3);
      expect(result.current.messages[2].id).toBe(6);
      expect(result.current.hasOlder).toBe(true);
    });

    it('removed delta for a hidden message adjusts hiddenOlderCount without shifting visible window', () => {
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 2 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4), makeMessage(5)],
          version: 1,
        });
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].id).toBe(4);
      expect(result.current.messages[1].id).toBe(5);
      expect(result.current.hasOlder).toBe(true);

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          removed: [makeMessage(2)],
          version: 2,
        });
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].id).toBe(4);
      expect(result.current.messages[1].id).toBe(5);
      expect(result.current.hasOlder).toBe(true);

      act(() => {
        result.current.loadEarlier();
      });

      expect(result.current.messages).toHaveLength(4);
      expect(result.current.messages[0].id).toBe(1);
      expect(result.current.messages[1].id).toBe(3);
      expect(result.current.hasOlder).toBe(false);
    });

    it('hiddenOlderCount resets to 0 when groupId changes', () => {
      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string }) => useGroupMessages(groupId, { pageSize: 2 }),
        { initialProps: { groupId: 'group-1' } }
      );

      const subId1 = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId1,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4), makeMessage(5)],
          version: 1,
        });
      });

      expect(result.current.hasOlder).toBe(true);
      expect(result.current.messages).toHaveLength(2);

      act(() => {
        rerender({ groupId: 'group-2' });
      });

      expect(result.current.messages).toHaveLength(0);
      expect(result.current.hasOlder).toBe(false);
    });
  });
});
