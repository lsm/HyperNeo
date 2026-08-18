import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { useMessageHub } from './useMessageHub';
import type {
  LiveQueryDeltaEvent,
  LiveQueryErrorEvent,
  LiveQuerySnapshotEvent,
} from '@hyperneo/shared';

export interface SessionGroupMessage {
  id: number | string;
  groupId: string;
  sessionId: string | null;
  role: string;
  messageType: string;
  content: string;
  createdAt: number;
  parentToolUseId?: string | null;
}

export const DEFAULT_PAGE_SIZE = 50;

export interface UseGroupMessagesOptions {
  pageSize?: number;
}

export interface UseGroupMessagesResult {
  messages: SessionGroupMessage[];
  isLoading: boolean;
  isReconnecting: boolean;
  hasOlder: boolean;
  loadEarlier: () => void;
}

interface PaginationState {
  allMessages: SessionGroupMessage[];
  hiddenOlderCount: number;
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

function isTopLevel(msg: SessionGroupMessage): boolean {
  return !msg.parentToolUseId;
}

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
        hiddenTL = countTopLevel(msgs.slice(0, hidden));
      }

      if (action.added && action.added.length > 0) {
        const boundaryId = hidden > 0 && hidden < msgs.length ? String(msgs[hidden].id) : null;

        msgs = [...msgs, ...action.added];
        const sorted = sortMessages(msgs);

        if (boundaryId !== null) {
          const newHidden = sorted.findIndex((m) => String(m.id) === boundaryId);
          if (newHidden >= 0) {
            hidden = newHidden;
          }
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

let _subscriptionCounter = 0;

export function generateGroupMessagesSubId(groupId: string): string {
  _subscriptionCounter += 1;
  return `group-messages-${groupId}-${_subscriptionCounter}`;
}

export function resetSubscriptionCounterForTesting(): void {
  _subscriptionCounter = 0;
}

export function useGroupMessages(
  groupId: string | null,
  options?: UseGroupMessagesOptions
): UseGroupMessagesResult {
  const pageSizeRef = useRef(options?.pageSize ?? DEFAULT_PAGE_SIZE);
  pageSizeRef.current = options?.pageSize ?? DEFAULT_PAGE_SIZE;

  const { request, onEvent, isConnected } = useMessageHub();

  const [{ allMessages, hiddenOlderCount, hiddenTopLevelCount }, dispatch] = useReducer(
    paginationReducer,
    INITIAL_PAGINATION_STATE
  );
  const [loadedForGroupId, setLoadedForGroupId] = useState<string | null>(null);

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
    dispatch({ type: 'reset' });
    setLoadedForGroupId(null);

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

    const unsubError = onEvent<LiveQueryErrorEvent>('liveQuery.error', (event) => {
      if (event.subscriptionId !== activeSubIdRef.current) return;
      if (event.phase === 'delta') {
        request('liveQuery.subscribe', {
          queryName: 'sessionGroupMessages.byGroup',
          params: [groupId],
          subscriptionId,
        }).catch(() => setLoadedForGroupId(groupId));
        return;
      }
      setLoadedForGroupId(groupId);
    });

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
            setLoadedForGroupId(groupId);
          }
        }
      });
    };

    subscribeWithRetry(0);

    return () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }

      unsubSnapshot();
      unsubDelta();
      unsubError();

      activeSubIdRef.current = null;

      Promise.resolve(request('liveQuery.unsubscribe', { subscriptionId })).catch(() => {
        // Ignore cleanup errors.
      });
    };
  }, [groupId, isConnected, request, onEvent]);

  const messages = useMemo(
    () => allMessages.slice(hiddenOlderCount),
    [allMessages, hiddenOlderCount]
  );

  const loadEarlier = useCallback(() => {
    dispatch({ type: 'loadEarlier', pageSize: pageSizeRef.current });
  }, []);

  const isLoading = groupId !== null && isConnected && loadedForGroupId !== groupId;

  return {
    messages,
    isLoading,
    isReconnecting: !isConnected && groupId !== null,
    hasOlder: hiddenTopLevelCount > 0,
    loadEarlier,
  };
}
