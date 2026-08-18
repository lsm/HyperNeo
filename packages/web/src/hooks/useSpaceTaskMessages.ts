import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  ActiveTurnSummary,
  ActivityEntry,
  LiveQueryDeltaEvent,
  LiveQueryErrorEvent,
  LiveQuerySnapshotEvent,
  MessageDeliveryStatus,
} from '@hyperneo/shared';
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
}

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

const SNAPSHOT_RETRY_DELAY_MS = 2000;
const MAX_SNAPSHOT_RETRIES = 5;

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

function applyDelta(
  currentRows: SpaceTaskThreadMessageRow[],
  event: LiveQueryDeltaEvent
): SpaceTaskThreadMessageRow[] {
  const next = new Map(currentRows.map((row) => [String(row.id), row]));
  for (const row of (event.removed ?? []) as SpaceTaskThreadMessageRow[]) {
    next.delete(String(row.id));
  }
  for (const row of (event.updated ?? []) as SpaceTaskThreadMessageRow[]) {
    next.set(String(row.id), row);
  }
  for (const row of (event.added ?? []) as SpaceTaskThreadMessageRow[]) {
    next.set(String(row.id), row);
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

export function useSpaceTaskMessages(
  taskId: string | null,
  variant: SpaceTaskMessagesQueryVariant = 'compact'
): UseSpaceTaskMessagesResult {
  const { request, onEvent, getHub, isConnected } = useMessageHub();
  const [rows, setRows] = useState<SpaceTaskThreadMessageRow[]>([]);
  const [activeTurnRows, setActiveTurnRows] = useState<ActiveTurnEntryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedForTaskId, setLoadedForTaskId] = useState<string | null>(null);
  const activeSubIdRef = useRef<string | null>(null);
  const activeTurnSubIdRef = useRef<string | null>(null);

  const queryName =
    variant === 'full' ? 'spaceTaskMessages.byTask' : 'spaceTaskMessages.byTask.compact';

  useEffect(() => {
    if (!taskId || !isConnected) {
      setRows([]);
      setActiveTurnRows([]);
      setLoadedForTaskId(null);
      setError(null);
      activeSubIdRef.current = null;
      activeTurnSubIdRef.current = null;
      return;
    }

    const subscriptionId = nextTaskMessageSubId(taskId);
    const activeTurnSubscriptionId = nextActiveTurnSubId(taskId);
    const shouldSubscribeActiveTurn = variant === 'compact';
    activeSubIdRef.current = subscriptionId;
    activeTurnSubIdRef.current = shouldSubscribeActiveTurn ? activeTurnSubscriptionId : null;
    const snapshotRetryTimers = new Set<ReturnType<typeof setTimeout>>();
    let sawSnapshot = false;
    let snapshotRetries = 0;
    let subscribeGeneration = 0;
    setRows([]);
    setActiveTurnRows([]);
    setLoadedForTaskId(null);
    setError(null);

    const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId === activeSubIdRef.current) {
        sawSnapshot = true;
        setRows(sortRows((event.rows as SpaceTaskThreadMessageRow[]) ?? []));
        setLoadedForTaskId(taskId);
        return;
      }
      if (event.subscriptionId === activeTurnSubIdRef.current) {
        setActiveTurnRows(sortActiveTurnRows((event.rows as ActiveTurnEntryRow[]) ?? []));
      }
    });

    const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId === activeSubIdRef.current) {
        setRows((prev) => applyDelta(prev, event));
        return;
      }
      if (event.subscriptionId === activeTurnSubIdRef.current) {
        setActiveTurnRows((prev) => applyActiveTurnDelta(prev, event));
      }
    });

    const unsubError = onEvent<LiveQueryErrorEvent>('liveQuery.error', (event) => {
      if (event.subscriptionId === activeSubIdRef.current) {
        if (event.phase === 'delta') {
          subscribe(true);
          return;
        }
        sawSnapshot = true;
        setError(event.message);
        setLoadedForTaskId(taskId);
        return;
      }
      if (event.subscriptionId === activeTurnSubIdRef.current) {
        if (event.phase === 'delta') {
          const hub = getHub();
          if (hub) {
            hub
              .request('liveQuery.subscribe', {
                queryName: 'spaceTaskActiveTurn.byTask',
                params: [taskId],
                subscriptionId: activeTurnSubscriptionId,
              })
              .catch(() => setActiveTurnRows([]));
          }
          return;
        }
        setError(event.message);
        setActiveTurnRows([]);
      }
    });

    const subscribe = (resetRetryCount = false) => {
      const hub = getHub();
      if (!hub) return;
      sawSnapshot = false;
      if (resetRetryCount) {
        snapshotRetries = 0;
      }
      subscribeGeneration += 1;
      const generation = subscribeGeneration;
      hub
        .request('liveQuery.subscribe', {
          queryName,
          params: [taskId],
          subscriptionId,
        })
        .then(() => {
          if (snapshotRetries >= MAX_SNAPSHOT_RETRIES) {
            if (activeSubIdRef.current === subscriptionId && !sawSnapshot) {
              setLoadedForTaskId(taskId);
            }
            return;
          }
          snapshotRetries += 1;
          const retryTimer = setTimeout(() => {
            snapshotRetryTimers.delete(retryTimer);
            if (
              activeSubIdRef.current === subscriptionId &&
              generation === subscribeGeneration &&
              !sawSnapshot
            ) {
              subscribe();
            }
          }, SNAPSHOT_RETRY_DELAY_MS);
          snapshotRetryTimers.add(retryTimer);
        })
        .catch(() => {
          if (activeSubIdRef.current === subscriptionId) {
            setLoadedForTaskId(taskId);
          }
        });
      if (shouldSubscribeActiveTurn) {
        hub
          .request('liveQuery.subscribe', {
            queryName: 'spaceTaskActiveTurn.byTask',
            params: [taskId],
            subscriptionId: activeTurnSubscriptionId,
          })
          .catch(() => {
            if (activeTurnSubIdRef.current === activeTurnSubscriptionId) {
              setActiveTurnRows([]);
            }
          });
      }
    };

    const unsubReconnect = getHub()?.onConnection((state) => {
      if (state !== 'connected') return;
      if (activeSubIdRef.current !== subscriptionId) return;
      setLoadedForTaskId(null);
      setError(null);
      subscribe(true);
    });

    subscribe(true);

    return () => {
      for (const timer of snapshotRetryTimers) clearTimeout(timer);
      snapshotRetryTimers.clear();
      unsubSnapshot();
      unsubDelta();
      unsubError();
      unsubReconnect?.();
      activeSubIdRef.current = null;
      activeTurnSubIdRef.current = null;
      Promise.resolve(request('liveQuery.unsubscribe', { subscriptionId })).catch(() => {});
      if (shouldSubscribeActiveTurn) {
        Promise.resolve(
          request('liveQuery.unsubscribe', { subscriptionId: activeTurnSubscriptionId })
        ).catch(() => {});
      }
    };
  }, [taskId, isConnected, onEvent, request, getHub, queryName, variant]);

  const sortedRows = useMemo(() => sortRows(rows), [rows]);
  const activeTurnSummaries = useMemo(
    () => buildActiveTurnSummaries(activeTurnRows),
    [activeTurnRows]
  );

  const isLoading = taskId !== null && isConnected && loadedForTaskId !== taskId;

  return {
    rows: sortedRows,
    activeTurnSummaries,
    isLoading,
    error,
    isReconnecting: !isConnected && taskId !== null,
  };
}
