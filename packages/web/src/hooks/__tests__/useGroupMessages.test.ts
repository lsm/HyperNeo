/**
 * Tests for useGroupMessages Hook
 *
 * Verifies LiveQuery subscription lifecycle for session group messages:
 * - Snapshot delivery (initial message load)
 * - Delta append (new messages via real-time push)
 * - Stale-event guard (rapid task switching)
 * - Full CRUD delta handling (added/updated/removed)
 * - Cleanup on unmount / groupId change
 * - Reconnect: re-subscribes after WebSocket disconnect/reconnect
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Hoisted mocks (must not import anything)
// ---------------------------------------------------------------------------

const { mockRequest, mockOnEvent, mockIsConnected } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockOnEvent: vi.fn(),
  mockIsConnected: { value: true },
}));

// Mock useMessageHub so we control request, onEvent, and isConnected directly.
vi.mock('../useMessageHub', () => ({
  useMessageHub: () => ({
    request: mockRequest,
    onEvent: mockOnEvent,
    get isConnected() {
      return mockIsConnected.value;
    },
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  useGroupMessages,
  generateGroupMessagesSubId,
  resetSubscriptionCounterForTesting,
  type SessionGroupMessage,
} from '../useGroupMessages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal top-level SessionGroupMessage for use in tests. */
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

/**
 * Builds a subagent child message whose parentToolUseId ties it to a parent.
 * The `subId` is used to give each child a unique id and a createdAt after
 * the parent, so they sort correctly (parent at 1_000_000+parentId, children
 * start at 2_000_000+subId to ensure they always sort after the parent).
 */
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

/** Handler registry keyed by event name for simulating server pushes. */
type EventHandler = (event: unknown) => void;
let eventHandlers: Record<string, EventHandler[]> = {};

function fireEvent(method: string, payload: unknown): void {
  (eventHandlers[method] ?? []).forEach((h) => h(payload));
}

/** Returns the subscriptionId from the most recent liveQuery.subscribe call. */
function lastSubscribeSubId(): string {
  const subscribeCalls = mockRequest.mock.calls.filter((call) => call[0] === 'liveQuery.subscribe');
  return subscribeCalls[subscribeCalls.length - 1][1].subscriptionId;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  resetSubscriptionCounterForTesting();
  mockIsConnected.value = true;
  eventHandlers = {};

  // Default: subscribe/unsubscribe resolve immediately.
  mockRequest.mockResolvedValue({ ok: true });

  // onEvent registers handlers and returns an unsubscribe stub.
  mockOnEvent.mockImplementation((method: string, handler: EventHandler) => {
    if (!eventHandlers[method]) eventHandlers[method] = [];
    eventHandlers[method].push(handler);
    return () => {
      eventHandlers[method] = (eventHandlers[method] ?? []).filter((h) => h !== handler);
    };
  });
});

// Note: no afterEach reset here. `beforeEach` resets mocks before each test.
// Adding vi.resetAllMocks() in afterEach would reset mocks before
// @testing-library/preact's cleanup fires, causing useEffect cleanup to fail
// when it calls request() (which would return undefined after reset).

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

      // Deliver snapshot first.
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });

      // Deliver delta with one new message.
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

      // Delta with only removed — message 1 should be gone.
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

      // Delta with only updated — message 1 should have new content.
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

      // Delta from old subscription.
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

      // Switch to group-2 before first snapshot arrives.
      rerender({ groupId: 'group-2' });

      // Now the stale snapshot from group-1 arrives — should be discarded.
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

      // Find the subscribe call for group-2.
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

    // Regression coverage for the empty-state flash: when groupId switches
    // from an already-loaded group to a new one, the render immediately
    // following the switch must report isLoading=true. Before the fix,
    // `isLoading` was flipped back to true from inside useEffect, leaving
    // one render where rows were empty and isLoading was false — which the
    // consumer (TaskConversationRenderer) rendered as "No conversation
    // history found" before the new snapshot arrived.
    it('reports isLoading=true on the render following a groupId switch', () => {
      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' as string | null } }
      );

      // Finish loading group-1.
      const firstSubId = lastSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });
      expect(result.current.isLoading).toBe(false);

      // Switch to group-2 — isLoading must be true again immediately,
      // not one render later when the effect fires.
      rerender({ groupId: 'group-2' });
      expect(result.current.isLoading).toBe(true);
      // Existing rows must be cleared so the consumer does not briefly
      // show group-1's messages under the new group-2 header.
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

      // Initial subscription — deliver snapshot with one message.
      const firstSubId = lastSubscribeSubId();
      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: firstSubId,
          rows: [makeMessage(1)],
          version: 1,
        });
      });
      expect(result.current.messages).toHaveLength(1);

      // Simulate disconnect: isConnected becomes false.
      act(() => {
        rerender({ isConn: false });
      });

      // Simulate reconnect: isConnected becomes true again.
      act(() => {
        rerender({ isConn: true });
      });

      // A new subscription should have been issued.
      const reconnectSubId = lastSubscribeSubId();
      expect(reconnectSubId).not.toBe(firstSubId);

      // Deliver the fresh snapshot from the new subscription.
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

      // Reconnect cycle.
      act(() => {
        rerender({ isConn: false });
      });
      act(() => {
        rerender({ isConn: true });
      });

      // Stale delta from old subscription must be discarded.
      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: firstSubId,
          added: [makeMessage(99)],
          version: 2,
        });
      });

      // No messages until the new subscription delivers its snapshot.
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

      // No handlers should remain registered.
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
      // All 3 attempts (initial + 2 retries) fail.
      mockRequest.mockRejectedValue(new Error('subscribe failed'));

      const { result } = renderHook(() => useGroupMessages('group-1'));

      expect(result.current.isLoading).toBe(true);

      // Drain microtasks for first failure.
      await act(async () => {
        await Promise.resolve();
      });
      // Still loading — retries pending.
      expect(result.current.isLoading).toBe(true);

      // Advance past first retry delay (500ms) and drain its microtasks.
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });
      // Still loading — second retry pending.
      expect(result.current.isLoading).toBe(true);

      // Advance past second retry delay (1500ms) and drain its microtasks.
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      // All retries exhausted — isLoading must be false now.
      expect(result.current.isLoading).toBe(false);

      vi.useRealTimers();
    });

    it('succeeds on retry after initial subscribe failure', async () => {
      vi.useFakeTimers();

      // First call fails, second succeeds.
      mockRequest
        .mockRejectedValueOnce(new Error('first attempt failed'))
        .mockResolvedValue({ ok: true });

      const { result } = renderHook(() => useGroupMessages('group-1'));

      // Drain microtasks for the first failure.
      await act(async () => {
        await Promise.resolve();
      });

      // Advance past first retry delay and let the retry request run.
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });

      // Retry succeeded — still loading (waiting for snapshot).
      expect(result.current.isLoading).toBe(true);

      // Snapshot arrives on the new subscription.
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
      // First call (group-1 subscribe) hangs.
      mockRequest.mockReturnValueOnce(
        new Promise<never>((_, reject) => {
          rejectSubscribe = reject;
        })
      );
      // Subsequent calls (unsubscribe + group-2 subscribe) resolve.
      mockRequest.mockResolvedValue({ ok: true });

      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' } }
      );

      // Switch to group-2 before group-1 subscribe settles.
      rerender({ groupId: 'group-2' });

      // Reject group-1's subscribe after the switch.
      await act(async () => {
        rejectSubscribe(new Error('late failure'));
        await Promise.resolve();
      });

      // group-2 is still loading (snapshot hasn't arrived) — stale error must
      // not clear the loading flag.
      expect(result.current.isLoading).toBe(true);

      vi.useRealTimers();
    });

    it('cancels pending retry when groupId changes', async () => {
      vi.useFakeTimers();

      // group-1 subscribe fails → retry scheduled.
      mockRequest.mockRejectedValueOnce(new Error('fail'));
      // All subsequent calls resolve (unsubscribe, group-2 subscribe).
      mockRequest.mockResolvedValue({ ok: true });

      const { result, rerender } = renderHook(
        ({ groupId }: { groupId: string | null }) => useGroupMessages(groupId),
        { initialProps: { groupId: 'group-1' } }
      );

      // Drain microtasks so the failure registers.
      await act(async () => {
        await Promise.resolve();
      });

      // Switch groupId — this cancels the pending retry for group-1.
      rerender({ groupId: 'group-2' });

      // Advance past retry delay — the retry should NOT fire for group-2.
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });

      // group-2 subscribe was called exactly once (no extra retry calls for group-1).
      const group2Calls = mockRequest.mock.calls.filter(
        (call) => call[0] === 'liveQuery.subscribe' && call[1]?.params?.[0] === 'group-2'
      );
      expect(group2Calls).toHaveLength(1);

      // group-2 is still loading (snapshot hasn't arrived).
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
      // 20 top-level messages + 1 parent (also top-level) + 70 children = 91 total.
      // 21 top-level < pageSize=50, so all 91 messages should be visible and hasOlder=false.
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 50 }));
      const subId = lastSubscribeSubId();

      const topLevel = Array.from({ length: 20 }, (_, i) => makeMessage(i + 1));
      const parent = makeMessage(21); // top-level parent of the subagent block
      const children = Array.from({ length: 70 }, (_, i) => makeChild(i + 1, 'tool-use-id-21'));

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [...topLevel, parent, ...children],
          version: 1,
        });
      });

      // All 91 messages visible — subagent block not split
      expect(result.current.messages).toHaveLength(91);
      // No older messages — 21 top-level < pageSize=50
      expect(result.current.hasOlder).toBe(false);
    });

    it('subagent block never split: parent and all children always shown together', () => {
      // 55 top-level messages + 1 parent + 10 children = 66 total, 56 top-level.
      // pageSize=50 → hide oldest 6 top-level; parent (top-level #56) is visible
      // so all 10 children must also be visible.
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

      // 56 top-level, pageSize=50 → 6 oldest top-level hidden
      expect(result.current.hasOlder).toBe(true);
      // Visible: 50 top-level (messages 7-56) + 10 children = 60
      expect(result.current.messages).toHaveLength(60);
      // Parent (msg 56) must be in the visible window
      expect(result.current.messages.some((m) => m.id === 56)).toBe(true);
      // All 10 children must be in the visible window
      const visibleChildIds = result.current.messages
        .filter((m) => (m as SessionGroupMessage).parentToolUseId === 'tool-use-id-56')
        .map((m) => m.id);
      expect(visibleChildIds).toHaveLength(10);
    });

    it('loadEarlier reveals top-level messages and their children together', () => {
      // 4 top-level + 1 parent + 5 children = 10 total, 5 top-level.
      // pageSize=3 → hide 2 oldest top-level; show newest 3 top-level + 5 children.
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

      // 5 top-level, pageSize=3 → 2 hidden (msg 1 and msg 2)
      expect(result.current.hasOlder).toBe(true);
      // Visible: msg 3, msg 4, parent (msg 5) + 5 children = 8
      expect(result.current.messages).toHaveLength(8);

      act(() => {
        result.current.loadEarlier();
      });

      // After loadEarlier: all 10 messages visible
      expect(result.current.messages).toHaveLength(10);
      expect(result.current.hasOlder).toBe(false);
    });

    it('does not crash when a combined removed+added delta removes all visible messages', () => {
      // Regression for: msgs[hidden] is undefined when removed eliminates all
      // visible messages before the added/sort step reads msgs[hidden].id.
      // State: [A, B, C], hidden=2 → C is the only visible message.
      // Delta: remove C and add D in the same event.
      const { result } = renderHook(() => useGroupMessages('group-1', { pageSize: 1 }));
      const subId = lastSubscribeSubId();

      act(() => {
        fireEvent('liveQuery.snapshot', {
          subscriptionId: subId,
          rows: [makeMessage(1), makeMessage(2), makeMessage(3)],
          version: 1,
        });
      });

      // pageSize=1, 3 top-level → hidden=[1,2], visible=[3]
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe(3);

      // Remove the only visible message and simultaneously add a new one.
      const newMsg = makeMessage(4);
      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          removed: [makeMessage(3)],
          added: [newMsg],
          version: 2,
        });
      });

      // No crash. After removal hidden=2, msgs=[1,2]; after add+sort msgs=[1,2,4].
      // boundaryId=null (hidden >= msgs.length after removal), so sort does not
      // re-anchor — all of [1,2,4] are evaluated by topLevelCutoffIndex on the
      // next snapshot, but here we just verify stability.
      // hiddenOlderCount stays at 2 (msgs[2]=4 is visible).
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe(4);
    });

    it('delta-added child with createdAt in hidden region is placed in hidden region, not visible window', () => {
      // 5 top-level messages, pageSize=2 → hidden=[1,2,3], visible=[4,5].
      // A subagent child arrives via delta with createdAt between msg2 and msg3,
      // so it sorts into the hidden region. The visible window must stay [4,5].
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

      // Late-arriving child: createdAt=1_000_002 + 0.5 → between msg2 and msg3.
      // We approximate with createdAt=1_000_002 (ties with msg2; string id sorts it after).
      // The key point is it falls before the boundary (msg4 at 1_000_004).
      const lateChild: SessionGroupMessage = {
        id: 'late-child',
        groupId: 'group-1',
        sessionId: null,
        role: 'assistant',
        messageType: 'text',
        content: 'late-child',
        createdAt: 1_000_002, // before boundary msg4 (1_000_004)
        parentToolUseId: 'tool-use-id-2',
      };

      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          added: [lateChild],
          version: 2,
        });
      });

      // Visible window must still be [4, 5] — late child sorted into hidden region.
      // hiddenOlderCount was re-anchored to the identity of msg4.
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].id).toBe(4);
      expect(result.current.messages[1].id).toBe(5);
      // hasOlder still true — hidden region now has [1, 2, late-child, 3]
      expect(result.current.hasOlder).toBe(true);
    });

    it('hasOlder is false when all messages are subagent children of a single visible parent', () => {
      // 1 top-level parent + 20 children — all fit in pageSize=5 top-level (only 1 TL)
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

      // 1 top-level < pageSize=5 → all 21 visible, hasOlder=false
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
      // Counter was reset in beforeEach; first call should produce counter=1.
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
      // pageSize=2, snapshot has 5 messages → oldest 3 are hidden
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
      // Only the newest 2 messages are visible
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].id).toBe(4);
      expect(result.current.messages[1].id).toBe(5);
    });

    it('loadEarlier reveals the previous page of messages', () => {
      // 5 messages, pageSize=2 → shows [4,5], then after loadEarlier shows [2,3,4,5]
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

      // Now showing 4 messages: [2,3,4,5]
      expect(result.current.messages).toHaveLength(4);
      expect(result.current.messages[0].id).toBe(2);
      expect(result.current.messages[3].id).toBe(5);
    });

    it('loadEarlier clamps to 0 — cannot hide negative messages', () => {
      // 5 messages, pageSize=3 → first load shows [3,4,5]; then loadEarlier shows all
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

      // All 5 messages visible, hasOlder = false
      expect(result.current.messages).toHaveLength(5);
      expect(result.current.hasOlder).toBe(false);

      // Calling loadEarlier again is a no-op
      act(() => {
        result.current.loadEarlier();
      });

      expect(result.current.messages).toHaveLength(5);
    });

    it('new delta messages are always visible regardless of hiddenOlderCount', () => {
      // pageSize=2, snapshot has 5 → shows [4,5], 3 hidden
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

      // New message arrives via delta
      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          added: [makeMessage(6)],
          version: 2,
        });
      });

      // Still shows 2+1=3 messages (new one is always visible at end)
      expect(result.current.messages).toHaveLength(3);
      expect(result.current.messages[2].id).toBe(6);
      expect(result.current.hasOlder).toBe(true); // older messages still hidden
    });

    it('removed delta for a hidden message adjusts hiddenOlderCount without shifting visible window', () => {
      // pageSize=2, snapshot has 5 messages → shows [4,5], 3 hidden ([1,2,3])
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
      expect(result.current.hasOlder).toBe(true); // 3 hidden

      // Remove message 2 (which is in the hidden region)
      act(() => {
        fireEvent('liveQuery.delta', {
          subscriptionId: subId,
          removed: [makeMessage(2)],
          version: 2,
        });
      });

      // Visible window must still show [4, 5] — not shift to expose [3]
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].id).toBe(4);
      expect(result.current.messages[1].id).toBe(5);
      // hasOlder still true: 2 hidden messages remain ([1, 3])
      expect(result.current.hasOlder).toBe(true);

      // loadEarlier now reveals the remaining 2 hidden messages
      act(() => {
        result.current.loadEarlier();
      });

      expect(result.current.messages).toHaveLength(4); // [1, 3, 4, 5]
      expect(result.current.messages[0].id).toBe(1);
      expect(result.current.messages[1].id).toBe(3);
      expect(result.current.hasOlder).toBe(false);
    });

    it('hiddenOlderCount resets to 0 when groupId changes', () => {
      // First group: 5 messages with pageSize=2
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

      // Switch to a new group
      act(() => {
        rerender({ groupId: 'group-2' });
      });

      // Messages cleared, hasOlder reset
      expect(result.current.messages).toHaveLength(0);
      expect(result.current.hasOlder).toBe(false);
    });
  });
});
