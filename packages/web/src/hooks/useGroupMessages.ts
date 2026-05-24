/**
 * useGroupMessages Hook
 *
 * Subscribes to group timeline messages via LiveQuery for real-time streaming.
 * Messages are delivered via an initial snapshot followed by delta updates.
 *
 * Design constraints:
 * - Canonical source: timeline rows are queried from persisted sdk_messages +
 *   task_group_events (not a runtime projection table).
 * - Delta handling supports added/updated/removed rows to stay correct even when
 *   row mappers evolve or ordering metadata changes.
 * - Stale-event guard: tracks the active subscriptionId and discards events from
 *   prior group subscriptions during rapid task switching.
 * - Reconnect handling: `isConnected` is included in the effect dependency array
 *   so the subscription is re-established after a WebSocket disconnect/reconnect.
 * - Pagination: only the newest `pageSize` messages are shown initially. Older
 *   messages are stored in an internal buffer and revealed via `loadEarlier()`.
 *   New messages from live deltas are always appended and visible.
 *   `allMessages` and `hiddenOlderCount` are updated atomically via useReducer so
 *   that `removed` deltas in the hidden region keep the visible window consistent.
 * - `pageSize` is intentionally kept as a ref and NOT included in the subscription
 *   effect deps. Changing page size must not tear down and re-establish the WebSocket
 *   subscription — it only affects the initial hidden count and the loadEarlier step.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { useMessageHub } from './useMessageHub';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';

export interface SessionGroupMessage {
  id: number | string;
  groupId: string;
  sessionId: string | null;
  role: string;
  messageType: string;
  content: string;
  createdAt: number;
  /**
   * For SDK messages that are subagent tool results, this is the `parent_tool_use_id`
   * from the SDK message JSON — i.e. the `tool_use` block that spawned the subagent.
   * Null/undefined for top-level messages and all event rows.
   * Used by the pagination logic to keep subagent blocks intact across page boundaries.
   */
  parentToolUseId?: string | null;
}

/** Default number of messages shown initially and per "load earlier" page. */
export const DEFAULT_PAGE_SIZE = 50;

export interface UseGroupMessagesOptions {
  /**
   * Number of messages to show per page (default: DEFAULT_PAGE_SIZE).
   * Changes to this value do NOT trigger re-subscription — they only affect how
   * many messages are hidden/revealed per page.
   */
  pageSize?: number;
}

export interface UseGroupMessagesResult {
  messages: SessionGroupMessage[];
  isLoading: boolean;
  /** True when the WebSocket is disconnected but a groupId is set — messages will reload on reconnect. */
  isReconnecting: boolean;
  /** True when there are older messages not currently displayed. */
  hasOlder: boolean;
  /** Reveals the previous page of older messages from the buffer. Instant (no network request). */
  loadEarlier: () => void;
}

// ─── Internal reducer ─────────────────────────────────────────────────────────

interface PaginationState {
  /** All messages received from LiveQuery, sorted chronologically. */
  allMessages: SessionGroupMessage[];
  /**
   * Number of messages at the start of `allMessages` that are hidden.
   * The cutoff is always placed at a top-level message boundary so that subagent
   * blocks (parentToolUseId !== null) are never split across pages.
   * Updated atomically with `allMessages` so that removed deltas in the hidden
   * region never shift the visible window unexpectedly.
   */
  hiddenOlderCount: number;
  /**
   * Number of top-level messages (parentToolUseId is null/undefined) in the hidden
   * region. `hasOlder` is derived from this value so that the "Load earlier" button
   * only appears when there are actual top-level messages to reveal, not just orphaned
   * subagent children.
   */
  hiddenTopLevelCount: number;
}

type PaginationAction =
  | { type: 'reset' }
  | { type: 'snapshot'; rows: SessionGroupMessage[]; pageSize: number }
  | {
      type: 'delta';
      removed?: SessionGroupMessage[];
      updated?: SessionGroupMessage[];
      added?: SessionGroupMessage[];
    }
  | { type: 'loadEarlier'; pageSize: number };

function sortMessages(msgs: SessionGroupMessage[]): SessionGroupMessage[] {
  return [...msgs].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Returns true if the message is a top-level message (not a subagent child). */
function isTopLevel(msg: SessionGroupMessage): boolean {
  return !msg.parentToolUseId;
}

/**
 * Returns the index into `msgs` at which the visible window starts, such that
 * exactly `pageSize` **top-level** messages are visible (at or after that index).
 * The cut always falls on a top-level message boundary so subagent blocks are
 * never split across pages — all children of a hidden parent are also hidden.
 *
 * Assumption: children always have a `createdAt` strictly greater than their
 * parent's, which holds because the subagent can only run after the tool_use
 * message is recorded. The secondary sort by string `id` does not reflect
 * insertion order, so this assumption must hold at the timestamp level.
 *
 * Returns 0 when there are fewer than `pageSize` top-level messages (show all)
 * or when `pageSize <= 0` (degenerate — treat as show all).
 */
function topLevelCutoffIndex(msgs: SessionGroupMessage[], pageSize: number): number {
  if (pageSize <= 0) return 0;
  let tlCount = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (isTopLevel(msgs[i])) {
      tlCount++;
      if (tlCount >= pageSize) {
        return i;
      }
    }
  }
  return 0;
}

/** Counts top-level messages in `msgs`. */
function countTopLevel(msgs: SessionGroupMessage[]): number {
  let n = 0;
  for (const m of msgs) {
    if (isTopLevel(m)) n++;
  }
  return n;
}

function paginationReducer(state: PaginationState, action: PaginationAction): PaginationState {
  switch (action.type) {
    case 'reset':
      return { allMessages: [], hiddenOlderCount: 0, hiddenTopLevelCount: 0 };

    case 'snapshot': {
      const sorted = sortMessages(action.rows);
      // Cut at a top-level boundary so subagent blocks are never split.
      const cutoff = topLevelCutoffIndex(sorted, action.pageSize);
      return {
        allMessages: sorted,
        hiddenOlderCount: cutoff,
        hiddenTopLevelCount: countTopLevel(sorted.slice(0, cutoff)),
      };
    }

    case 'delta': {
      let msgs = state.allMessages;
      let hidden = state.hiddenOlderCount;
      let hiddenTL = state.hiddenTopLevelCount;

      if (action.removed && action.removed.length > 0) {
        const removedIds = new Set(action.removed.map((row) => String(row.id)));
        // Count how many removed messages were in the hidden region so we can
        // adjust hiddenOlderCount (and hiddenTopLevelCount) atomically to keep
        // the visible window stable.
        const hiddenSlice = msgs.slice(0, hidden);
        const removedInHidden = hiddenSlice.filter((row) => removedIds.has(String(row.id)));
        const removedTLInHidden = countTopLevel(removedInHidden);
        msgs = msgs.filter((row) => !removedIds.has(String(row.id)));
        hidden = Math.max(0, hidden - removedInHidden.length);
        hiddenTL = Math.max(0, hiddenTL - removedTLInHidden);
      }

      if (action.updated && action.updated.length > 0) {
        const updatedById = new Map(action.updated.map((row) => [String(row.id), row]));
        msgs = msgs.map((row) => updatedById.get(String(row.id)) ?? row);
        // Recompute hiddenTopLevelCount in case parentToolUseId changed on an updated row.
        hiddenTL = countTopLevel(msgs.slice(0, hidden));
      }

      if (action.added && action.added.length > 0) {
        // Record the boundary message's identity before sorting so we can find
        // its new position after the sort. This prevents the visible window from
        // silently shifting when a late-arriving added message (e.g. a backdated
        // subagent child) sorts into the hidden region and pushes the boundary
        // forward without hiddenOlderCount being updated.
        //
        // Guard: `hidden < msgs.length` handles the case where the preceding
        // `removed` step eliminated all visible messages (msgs.length === hidden).
        // In that situation there is no boundary to anchor — treat as fully visible.
        const boundaryId = hidden > 0 && hidden < msgs.length ? String(msgs[hidden].id) : null;

        msgs = [...msgs, ...action.added];
        const sorted = sortMessages(msgs);

        if (boundaryId !== null) {
          const newHidden = sorted.findIndex((m) => String(m.id) === boundaryId);
          if (newHidden >= 0) {
            hidden = newHidden;
          }
          // Recompute hiddenTopLevelCount from the updated hidden slice.
          hiddenTL = countTopLevel(sorted.slice(0, hidden));
        }

        return {
          allMessages: sorted,
          hiddenOlderCount: hidden,
          hiddenTopLevelCount: hiddenTL,
        };
      }

      return {
        allMessages: sortMessages(msgs),
        hiddenOlderCount: hidden,
        hiddenTopLevelCount: hiddenTL,
      };
    }

    case 'loadEarlier': {
      // Reveal the next pageSize top-level messages (and all their children) from
      // the hidden region by finding a new top-level cut within the hidden slice.
      const hiddenSlice = state.allMessages.slice(0, state.hiddenOlderCount);
      const newCutoff = topLevelCutoffIndex(hiddenSlice, action.pageSize);
      return {
        ...state,
        hiddenOlderCount: newCutoff,
        hiddenTopLevelCount: countTopLevel(hiddenSlice.slice(0, newCutoff)),
      };
    }
  }
}

const INITIAL_PAGINATION_STATE: PaginationState = {
  allMessages: [],
  hiddenOlderCount: 0,
  hiddenTopLevelCount: 0,
};

// ─── Subscription counter ─────────────────────────────────────────────────────

let _subscriptionCounter = 0;

/** Generates a unique subscription ID for each group subscription. Exported for testing. */
export function generateGroupMessagesSubId(groupId: string): string {
  _subscriptionCounter += 1;
  return `group-messages-${groupId}-${_subscriptionCounter}`;
}

/**
 * Resets the module-level subscription counter.
 * Call this in `beforeEach` to keep counter values deterministic across tests.
 */
export function resetSubscriptionCounterForTesting(): void {
  _subscriptionCounter = 0;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Hook to subscribe to session group messages via LiveQuery.
 *
 * Re-subscribes automatically when the WebSocket reconnects (`isConnected`
 * is included in the effect dependency array).
 *
 * Pagination: internally stores ALL messages from the LiveQuery snapshot.
 * Only the newest `pageSize` messages are exposed via `messages`. Older
 * messages are hidden and revealed one page at a time via `loadEarlier()`.
 * New live-delta messages are always appended to the visible end.
 * `removed` deltas correctly adjust `hiddenOlderCount` when removed messages
 * fall within the hidden region, so the visible window never shifts silently.
 *
 * @param groupId - The session group ID to subscribe to, or null to clear/unsubscribe.
 * @param options - Optional configuration (pageSize).
 * @returns Current message list, loading state, and pagination controls.
 *
 * @example
 * ```tsx
 * function TaskMessages({ groupId }: { groupId: string | null }) {
 *   const { messages, isLoading, hasOlder, loadEarlier } = useGroupMessages(groupId);
 *
 *   if (isLoading) return <Spinner />;
 *   return (
 *     <>
 *       {hasOlder && <button onClick={loadEarlier}>Load earlier</button>}
 *       <MessageList messages={messages} />
 *     </>
 *   );
 * }
 * ```
 */
export function useGroupMessages(
  groupId: string | null,
  options?: UseGroupMessagesOptions
): UseGroupMessagesResult {
  // pageSize is kept as a ref so it does NOT appear in the subscription effect's
  // dependency array — changing page size must not tear down the WebSocket subscription.
  const pageSizeRef = useRef(options?.pageSize ?? DEFAULT_PAGE_SIZE);
  pageSizeRef.current = options?.pageSize ?? DEFAULT_PAGE_SIZE;

  const { request, onEvent, isConnected } = useMessageHub();

  const [{ allMessages, hiddenOlderCount, hiddenTopLevelCount }, dispatch] = useReducer(
    paginationReducer,
    INITIAL_PAGINATION_STATE
  );
  /**
   * The groupId whose LiveQuery snapshot has been applied to `allMessages`.
   * `null` means either no subscription is active or we are still waiting
   * for the first snapshot of the current `groupId`. `isLoading` is derived
   * from the mismatch between this and the incoming `groupId` so the first
   * render (before the subscription effect runs) already reports `true` —
   * callers never briefly see an empty message list paired with
   * `isLoading=false`, which is what caused the empty-state flash on mount
   * and on task switch.
   */
  const [loadedForGroupId, setLoadedForGroupId] = useState<string | null>(null);

  // Track the active subscriptionId to guard against stale events from prior
  // group subscriptions (e.g., rapid task switching or reconnect cycles).
  const activeSubIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!groupId || !isConnected) {
      dispatch({ type: 'reset' });
      setLoadedForGroupId(null);
      activeSubIdRef.current = null;
      return;
    }

    const subscriptionId = generateGroupMessagesSubId(groupId);
    activeSubIdRef.current = subscriptionId;
    // Reset the visible message set + the "loaded" marker for the previous
    // group so consumers see the loading state (not stale rows or the
    // empty-state placeholder) while the new snapshot is in flight.
    dispatch({ type: 'reset' });
    setLoadedForGroupId(null);

    // Register event listeners BEFORE sending the subscribe request so the
    // snapshot that is delivered synchronously as part of the subscribe
    // response is not missed.
    const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId !== activeSubIdRef.current) return;
      dispatch({
        type: 'snapshot',
        rows: event.rows as SessionGroupMessage[],
        pageSize: pageSizeRef.current,
      });
      setLoadedForGroupId(groupId);
    });

    const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId !== activeSubIdRef.current) return;
      dispatch({
        type: 'delta',
        removed: event.removed as SessionGroupMessage[] | undefined,
        updated: event.updated as SessionGroupMessage[] | undefined,
        added: event.added as SessionGroupMessage[] | undefined,
      });
    });

    // Send the subscribe request with retry on failure.
    // Up to MAX_RETRIES additional attempts after the first, with increasing delays.
    // IMPORTANT: RETRY_DELAYS_MS must have exactly MAX_RETRIES entries — adding an extra
    // retry without a corresponding delay entry causes setTimeout(fn, undefined) → 0ms.
    const MAX_RETRIES = 2;
    const RETRY_DELAYS_MS: [number, number] = [500, 1500];

    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const subscribeWithRetry = (attempt: number): void => {
      request('liveQuery.subscribe', {
        queryName: 'sessionGroupMessages.byGroup',
        params: [groupId],
        subscriptionId,
      }).catch(() => {
        if (activeSubIdRef.current !== subscriptionId) return;
        if (attempt < MAX_RETRIES) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (activeSubIdRef.current === subscriptionId) {
              subscribeWithRetry(attempt + 1);
            }
          }, RETRY_DELAYS_MS[attempt]);
        } else {
          if (activeSubIdRef.current === subscriptionId) {
            // Release the loading gate after exhausting retries so
            // consumers can surface whatever terminal UI is
            // appropriate (empty or error) rather than stalling
            // on the loading state forever.
            setLoadedForGroupId(groupId);
          }
        }
      });
    };

    subscribeWithRetry(0);

    return () => {
      // Cancel any pending retry timer before clearing the subscription ID,
      // so the timer callback cannot observe a matching subscription ID after cleanup.
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }

      // Remove event listeners first.
      unsubSnapshot();
      unsubDelta();

      // Clear the active sub ID so in-flight events from this subscription
      // are discarded once the new effect runs.
      activeSubIdRef.current = null;

      // Fire-and-forget: ask the server to clean up the subscription.
      // Wrap in Promise.resolve() so cleanup is safe even if request()
      // returns a non-thenable value (e.g. in certain test scenarios).
      Promise.resolve(request('liveQuery.unsubscribe', { subscriptionId })).catch(() => {
        // Ignore cleanup errors.
      });
    };
  }, [groupId, isConnected, request, onEvent]); // pageSize intentionally omitted — see module comment

  // Expose only the visible slice: allMessages starting from hiddenOlderCount.
  // New live-delta messages always appear at the end (never hidden).
  const messages = useMemo(
    () => allMessages.slice(hiddenOlderCount),
    [allMessages, hiddenOlderCount]
  );

  // Reveal one more page of older messages from the internal buffer.
  const loadEarlier = useCallback(() => {
    dispatch({ type: 'loadEarlier', pageSize: pageSizeRef.current });
  }, []); // dispatch is stable from useReducer; pageSizeRef is a ref

  // Derived: we are loading whenever we have an active groupId + connection
  // but have not yet applied a snapshot for that group. Computing this
  // (instead of tracking it as separate state) means the very first render —
  // before the subscription effect runs — already returns `isLoading=true`,
  // which suppresses the empty-state flash on mount and on task switch.
  const isLoading = groupId !== null && isConnected && loadedForGroupId !== groupId;

  return {
    messages,
    isLoading,
    isReconnecting: !isConnected && groupId !== null,
    hasOlder: hiddenTopLevelCount > 0,
    loadEarlier,
  };
}
