import type {
  ActiveTurnSummary,
  ActivityEntry,
  LiveQueryDeltaEvent,
  LiveQueryErrorEvent,
  LiveQuerySnapshotEvent,
  MessageDeliveryStatus,
} from '@hyperneo/shared';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  createLiveQueryLifecycleState,
  type LiveQueryLifecycleEffect,
  type LiveQueryLifecycleEvent,
  type LiveQueryLifecycleState,
  transitionLiveQueryLifecycle,
} from '../lib/live-query-lifecycle';
import { useMessageHub } from './useMessageHub';

export interface SpaceTaskThreadMessageRow {
  id: string | number;
  sessionId: string | null;
  kind: 'task_agent' | 'node_agent';
  role: string;
  label: string;
  nodeExecutionId?: string | null;
  taskId: string;
  taskTitle: string;
  messageType: string;
  content: string;
  createdAt: number;
  origin?: string | null;
  deliveryState?: MessageDeliveryStatus | null;
  parentToolUseId?: string | null;
  turnIndex?: number;
  insOrder?: number | null;
  turnHiddenMessageCount?: number;
  sessionMessageCount?: number;
  contentTruncated?: boolean;
  contentBytes?: number;
}

interface ActiveTurnEntryRow {
  id: string;
  sessionId: string;
  turnIndex: number;
  ts: number;
  entry: ActivityEntry | null;
}

export type SpaceTaskMessagesQueryVariant = 'compact' | 'full';

export interface UseSpaceTaskMessagesResult {
  rows: SpaceTaskThreadMessageRow[];
  activeTurnSummaries: ActiveTurnSummary[];
  isLoading: boolean;
  error: string | null;
  isReconnecting: boolean;
  expandMessage: (messageId: string | number) => Promise<void>;
}

const SPACE_TASK_MESSAGES_COMPACT_DEFAULT_LIMIT = 20;

let _taskMessageSubCounter = 0;
function nextTaskMessageSubId(taskId: string): string {
  _taskMessageSubCounter += 1;
  return `space-task-messages-${taskId}-${_taskMessageSubCounter}`;
}

let _activeTurnSubCounter = 0;
function nextActiveTurnSubId(taskId: string): string {
  _activeTurnSubCounter += 1;
  return `space-task-active-turn-${taskId}-${_activeTurnSubCounter}`;
}

export function sortRows(rows: SpaceTaskThreadMessageRow[]): SpaceTaskThreadMessageRow[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (typeof a.insOrder === 'number' && typeof b.insOrder === 'number') {
      return a.insOrder - b.insOrder;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

export function sortActiveTurnRows(rows: ActiveTurnEntryRow[]): ActiveTurnEntryRow[] {
  return [...rows].sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
    if (a.ts !== b.ts) return a.ts - b.ts;
    const [ar, ab] = activeTurnRowPosition(a.id);
    const [br, bb] = activeTurnRowPosition(b.id);
    if (ar !== br) return ar - br;
    return ab - bb;
  });
}

function activeTurnRowPosition(id: string): [number, number] {
  const parts = id.split(':');
  const rowId = Number.parseInt(parts[parts.length - 2] ?? '', 10);
  const blockIdx = Number.parseInt(parts[parts.length - 1] ?? '', 10);
  return [Number.isNaN(rowId) ? 0 : rowId, Number.isNaN(blockIdx) ? 0 : blockIdx];
}

function mergeIncomingRow(
  prev: SpaceTaskThreadMessageRow | undefined,
  incoming: SpaceTaskThreadMessageRow
): SpaceTaskThreadMessageRow {
  const keepsExpansion =
    prev &&
    prev.contentTruncated === false &&
    incoming.contentTruncated === true &&
    prev.contentBytes === incoming.contentBytes;
  if (keepsExpansion) {
    return {
      ...incoming,
      content: prev.content,
      contentBytes: prev.contentBytes,
      contentTruncated: false,
    };
  }
  return incoming;
}

function applyDelta(
  currentRows: SpaceTaskThreadMessageRow[],
  event: LiveQueryDeltaEvent
): SpaceTaskThreadMessageRow[] {
  const next = new Map(currentRows.map((row) => [String(row.id), row]));
  for (const row of (event.removed ?? []) as SpaceTaskThreadMessageRow[]) {
    next.delete(String(row.id));
  }
  for (const row of (event.updated ?? []) as SpaceTaskThreadMessageRow[]) {
    next.set(String(row.id), mergeIncomingRow(next.get(String(row.id)), row));
  }
  for (const row of (event.added ?? []) as SpaceTaskThreadMessageRow[]) {
    next.set(String(row.id), mergeIncomingRow(next.get(String(row.id)), row));
  }
  return sortRows(Array.from(next.values()));
}

function applyActiveTurnDelta(
  currentRows: ActiveTurnEntryRow[],
  event: LiveQueryDeltaEvent
): ActiveTurnEntryRow[] {
  const next = new Map(currentRows.map((row) => [row.id, row]));
  for (const row of (event.removed ?? []) as ActiveTurnEntryRow[]) {
    next.delete(row.id);
  }
  for (const row of (event.updated ?? []) as ActiveTurnEntryRow[]) {
    next.set(row.id, row);
  }
  for (const row of (event.added ?? []) as ActiveTurnEntryRow[]) {
    next.set(row.id, row);
  }
  return sortActiveTurnRows(Array.from(next.values()));
}

function buildActiveTurnSummaries(rows: ActiveTurnEntryRow[]): ActiveTurnSummary[] {
  const bySession = new Map<string, ActiveTurnSummary>();
  for (const row of sortActiveTurnRows(rows)) {
    if (!row.sessionId || !row.entry) continue;
    let summary = bySession.get(row.sessionId);
    if (!summary) {
      summary = { sessionId: row.sessionId, turnIndex: row.turnIndex, entries: [] };
      bySession.set(row.sessionId, summary);
    }
    summary.entries.push(row.entry);
  }
  return Array.from(bySession.values());
}

type LifecycleStorePayload = LiveQuerySnapshotEvent | LiveQueryDeltaEvent | null;

export function useSpaceTaskMessages(
  taskId: string | null,
  variant: SpaceTaskMessagesQueryVariant = 'compact',
  limit = SPACE_TASK_MESSAGES_COMPACT_DEFAULT_LIMIT
): UseSpaceTaskMessagesResult {
  const { request, onEvent, getHub, isConnected } = useMessageHub();
  const [rows, setRows] = useState<SpaceTaskThreadMessageRow[]>([]);
  const [activeTurnRows, setActiveTurnRows] = useState<ActiveTurnEntryRow[]>([]);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [activeTurnError, setActiveTurnError] = useState<string | null>(null);
  const [loadedForTaskId, setLoadedForTaskId] = useState<string | null>(null);

  const queryName =
    variant === 'full' ? 'spaceTaskMessages.byTask' : 'spaceTaskMessages.byTask.compact';

  useEffect(() => {
    if (!taskId || !isConnected) {
      setRows([]);
      setActiveTurnRows([]);
      setLoadedForTaskId(null);
      setMessageError(null);
      setActiveTurnError(null);
      return;
    }

    const subscriptionId = nextTaskMessageSubId(taskId);
    const activeTurnSubscriptionId = nextActiveTurnSubId(taskId);
    const shouldSubscribeActiveTurn = variant === 'compact';
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();

    setRows([]);
    setActiveTurnRows([]);
    setLoadedForTaskId(null);
    setMessageError(null);
    setActiveTurnError(null);

    const initial = createLiveQueryLifecycleState();
    let lifecycle: LiveQueryLifecycleState = initial.state;

    const dispatch = (event: LiveQueryLifecycleEvent): LiveQueryLifecycleEffect[] => {
      const result = transitionLiveQueryLifecycle(lifecycle, event);
      lifecycle = result.state;
      if (lifecycle.status !== 'disposed') setMessageError(lifecycle.error);
      return result.effects;
    };

    const executeEffects = (
      effects: LiveQueryLifecycleEffect[],
      payload: LifecycleStorePayload = null
    ): void => {
      for (const effect of effects) {
        if (effect.kind === 're-snapshot') {
          const hub = getHub();
          if (!hub) continue;
          const params = variant === 'full' ? [taskId] : [taskId, limit];
          hub
            .request('liveQuery.subscribe', { queryName, params, subscriptionId })
            .then(() => {
              executeEffects(dispatch({ type: 'subscribed', generation: effect.generation }));
            })
            .catch(() => {
              executeEffects(dispatch({ type: 'snapshot-failed', generation: effect.generation }));
            });
          if (shouldSubscribeActiveTurn) {
            hub
              .request('liveQuery.subscribe', {
                queryName: 'spaceTaskActiveTurn.byTask',
                params: [taskId],
                subscriptionId: activeTurnSubscriptionId,
              })
              .catch(() => {
                if (lifecycle.status !== 'disposed') setActiveTurnRows([]);
              });
          }
          continue;
        }
        if (effect.kind === 'retry-with-backoff') {
          const timer = setTimeout(() => {
            retryTimers.delete(timer);
            executeEffects(dispatch({ type: 'snapshot-failed', generation: effect.generation }));
          }, effect.delayMs);
          retryTimers.add(timer);
          continue;
        }
        if (effect.kind === 'schedule-cleanup') {
          for (const timer of retryTimers) clearTimeout(timer);
          retryTimers.clear();
          continue;
        }
        if (effect.emission.type === 'snapshot') {
          const snapshot = payload as LiveQuerySnapshotEvent | null;
          setRows((prev) => {
            const incoming = (snapshot?.rows as SpaceTaskThreadMessageRow[]) ?? [];
            const prevById = new Map(prev.map((row) => [String(row.id), row]));
            return sortRows(
              incoming.map((row) => mergeIncomingRow(prevById.get(String(row.id)), row))
            );
          });
          setLoadedForTaskId(taskId);
          continue;
        }
        if (effect.emission.type === 'delta') {
          const delta = payload as LiveQueryDeltaEvent | null;
          if (delta) setRows((prev) => applyDelta(prev, delta));
          continue;
        }
        setLoadedForTaskId(taskId);
      }
    };

    executeEffects(initial.effects);

    const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId === subscriptionId) {
        executeEffects(
          dispatch({ type: 'snapshot-arrived', generation: lifecycle.generation }),
          event
        );
        return;
      }
      if (shouldSubscribeActiveTurn && event.subscriptionId === activeTurnSubscriptionId) {
        setActiveTurnRows(sortActiveTurnRows((event.rows as ActiveTurnEntryRow[]) ?? []));
      }
    });

    const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId === subscriptionId) {
        executeEffects(
          dispatch({ type: 'delta-arrived', generation: lifecycle.generation }),
          event
        );
        return;
      }
      if (shouldSubscribeActiveTurn && event.subscriptionId === activeTurnSubscriptionId) {
        setActiveTurnRows((prev) => applyActiveTurnDelta(prev, event));
      }
    });

    const unsubError = onEvent<LiveQueryErrorEvent>('liveQuery.error', (event) => {
      if (event.subscriptionId === subscriptionId) {
        if (event.phase === 'delta') {
          executeEffects(dispatch({ type: 'transport-error', generation: lifecycle.generation }));
          return;
        }
        executeEffects(
          dispatch({
            type: 'snapshot-failed',
            generation: lifecycle.generation,
            message: event.message,
          })
        );
        return;
      }
      if (shouldSubscribeActiveTurn && event.subscriptionId === activeTurnSubscriptionId) {
        if (event.phase === 'delta') {
          getHub()
            ?.request('liveQuery.subscribe', {
              queryName: 'spaceTaskActiveTurn.byTask',
              params: [taskId],
              subscriptionId: activeTurnSubscriptionId,
            })
            .catch(() => {
              if (lifecycle.status !== 'disposed') setActiveTurnRows([]);
            });
          return;
        }
        setActiveTurnError(event.message);
        setActiveTurnRows([]);
      }
    });

    const unsubReconnect = getHub()?.onConnection((state) => {
      if (state !== 'connected') return;
      setLoadedForTaskId(null);
      setActiveTurnError(null);
      executeEffects(dispatch({ type: 'transport-error', generation: lifecycle.generation }));
    });

    return () => {
      executeEffects(dispatch({ type: 'unsubscribe' }));
      unsubSnapshot();
      unsubDelta();
      unsubError();
      unsubReconnect?.();
      Promise.resolve(request('liveQuery.unsubscribe', { subscriptionId })).catch(() => {});
      if (shouldSubscribeActiveTurn) {
        Promise.resolve(
          request('liveQuery.unsubscribe', { subscriptionId: activeTurnSubscriptionId })
        ).catch(() => {});
      }
    };
  }, [taskId, isConnected, onEvent, request, getHub, queryName, variant, limit]);

  const sortedRows = useMemo(() => sortRows(rows), [rows]);
  const activeTurnSummaries = useMemo(
    () => buildActiveTurnSummaries(activeTurnRows),
    [activeTurnRows]
  );

  const isLoading = taskId !== null && isConnected && loadedForTaskId !== taskId;
  const error = messageError ?? activeTurnError;

  const expandMessage = useCallback(
    async (messageId: string | number) => {
      if (!taskId) return;
      const hub = getHub();
      if (!hub) return;
      try {
        const { sdkMessage } = await hub.request<{ sdkMessage: string }>('spaceTaskMessage.get', {
          taskId,
          messageId: String(messageId),
        });
        setRows((prev) =>
          prev.map((row) =>
            String(row.id) === String(messageId)
              ? {
                  ...row,
                  content: sdkMessage,
                  contentTruncated: false,
                  contentBytes: sdkMessage.length,
                }
              : row
          )
        );
      } catch {}
    },
    [taskId, getHub]
  );

  return {
    rows: sortedRows,
    activeTurnSummaries,
    isLoading,
    error,
    isReconnecting: !isConnected && taskId !== null,
    expandMessage,
  };
}
