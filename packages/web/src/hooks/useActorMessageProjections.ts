import type {
  ActorMessageProjectionRow,
  LiveQueryDeltaEvent,
  LiveQuerySnapshotEvent,
} from '@hyperneo/shared';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useMessageHub } from './useMessageHub';

type ProjectionScope = 'task_timeline' | 'workflow_log';

interface UseActorMessageProjectionsOptions {
  scope: ProjectionScope;
  taskId?: string | null;
  workflowRunId?: string | null;
}

export interface UseActorMessageProjectionsResult {
  rows: ActorMessageProjectionRow[];
  isLoading: boolean;
  isReconnecting: boolean;
}

let _actorProjectionSubCounter = 0;

function nextProjectionSubId(scope: ProjectionScope, id: string): string {
  _actorProjectionSubCounter += 1;
  return `actor-message-projections-${scope}-${id}-${_actorProjectionSubCounter}`;
}

function sortRows(rows: ActorMessageProjectionRow[]): ActorMessageProjectionRow[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

function applyDelta(
  currentRows: ActorMessageProjectionRow[],
  event: LiveQueryDeltaEvent
): ActorMessageProjectionRow[] {
  const next = new Map(currentRows.map((row) => [row.id, row]));
  for (const row of (event.removed ?? []) as ActorMessageProjectionRow[]) {
    next.delete(row.id);
  }
  for (const row of (event.updated ?? []) as ActorMessageProjectionRow[]) {
    next.set(row.id, row);
  }
  for (const row of (event.added ?? []) as ActorMessageProjectionRow[]) {
    next.set(row.id, row);
  }
  return sortRows(Array.from(next.values()));
}

export function useActorMessageProjections({
  scope,
  taskId,
  workflowRunId,
}: UseActorMessageProjectionsOptions): UseActorMessageProjectionsResult {
  const { request, onEvent, getHub, isConnected } = useMessageHub();
  const [rows, setRows] = useState<ActorMessageProjectionRow[]>([]);
  const [loadedForKey, setLoadedForKey] = useState<string | null>(null);
  const activeSubIdRef = useRef<string | null>(null);

  const query = useMemo(() => {
    if (scope === 'task_timeline') {
      if (!taskId) return null;
      return {
        key: `${scope}:${taskId}`,
        queryName: 'actorMessages.byTask',
        params: [taskId],
      };
    }
    if (!workflowRunId) return null;
    return {
      key: `${scope}:${workflowRunId}`,
      queryName: 'actorMessages.byWorkflowRun',
      params: [workflowRunId, workflowRunId, workflowRunId],
    };
  }, [scope, taskId, workflowRunId]);

  useEffect(() => {
    if (!query || !isConnected) {
      setRows([]);
      setLoadedForKey(null);
      activeSubIdRef.current = null;
      return;
    }

    const subscriptionId = nextProjectionSubId(scope, query.key);
    activeSubIdRef.current = subscriptionId;
    setRows([]);
    setLoadedForKey(null);

    const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId !== activeSubIdRef.current) return;
      setRows(sortRows((event.rows as ActorMessageProjectionRow[]) ?? []));
      setLoadedForKey(query.key);
    });

    const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId !== activeSubIdRef.current) return;
      setRows((prev) => applyDelta(prev, event));
    });

    const subscribe = () => {
      const hub = getHub();
      if (!hub) return;
      hub
        .request('liveQuery.subscribe', {
          queryName: query.queryName,
          params: query.params,
          subscriptionId,
        })
        .catch(() => {
          if (activeSubIdRef.current === subscriptionId) {
            setLoadedForKey(query.key);
          }
        });
    };

    const unsubReconnect = getHub()?.onConnection((state) => {
      if (state !== 'connected') return;
      if (activeSubIdRef.current !== subscriptionId) return;
      setLoadedForKey(null);
      subscribe();
    });

    subscribe();

    return () => {
      unsubSnapshot();
      unsubDelta();
      unsubReconnect?.();
      activeSubIdRef.current = null;
      Promise.resolve(request('liveQuery.unsubscribe', { subscriptionId })).catch(() => {});
    };
  }, [getHub, isConnected, onEvent, query, request, scope]);

  const sortedRows = useMemo(() => sortRows(rows), [rows]);
  const activeKey = query?.key ?? null;

  return {
    rows: sortedRows,
    isLoading: activeKey !== null && isConnected && loadedForKey !== activeKey,
    isReconnecting: !isConnected && activeKey !== null,
  };
}
