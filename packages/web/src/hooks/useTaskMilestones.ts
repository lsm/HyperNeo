import type {
  LiveQueryDeltaEvent,
  LiveQuerySnapshotEvent,
  TaskMilestoneRow,
} from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useMessageHub } from './useMessageHub';

interface UseTaskMilestonesOptions {
  taskId?: string | null;
}

export interface UseTaskMilestonesResult {
  rows: TaskMilestoneRow[];
  isLoading: boolean;
  isReconnecting: boolean;
}

let _taskMilestoneSubCounter = 0;

function nextSubscriptionId(taskId: string): string {
  _taskMilestoneSubCounter += 1;
  return `task-milestones-${taskId}-${_taskMilestoneSubCounter}`;
}

function sortRows(rows: TaskMilestoneRow[]): TaskMilestoneRow[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

function applyDelta(
  currentRows: TaskMilestoneRow[],
  event: LiveQueryDeltaEvent
): TaskMilestoneRow[] {
  const next = new Map(currentRows.map((row) => [row.id, row]));
  for (const row of (event.removed ?? []) as TaskMilestoneRow[]) {
    next.delete(row.id);
  }
  for (const row of (event.updated ?? []) as TaskMilestoneRow[]) {
    next.set(row.id, row);
  }
  for (const row of (event.added ?? []) as TaskMilestoneRow[]) {
    next.set(row.id, row);
  }
  return sortRows(Array.from(next.values()));
}

export function useTaskMilestones({ taskId }: UseTaskMilestonesOptions): UseTaskMilestonesResult {
  const { request, onEvent, getHub, isConnected } = useMessageHub();
  const [rows, setRows] = useState<TaskMilestoneRow[]>([]);
  const [loadedForTaskId, setLoadedForTaskId] = useState<string | null>(null);
  const activeSubIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!taskId || !isConnected) {
      setRows([]);
      setLoadedForTaskId(null);
      activeSubIdRef.current = null;
      return;
    }

    const subscriptionId = nextSubscriptionId(taskId);
    activeSubIdRef.current = subscriptionId;
    setRows([]);
    setLoadedForTaskId(null);

    const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId !== activeSubIdRef.current) return;
      setRows(sortRows((event.rows as TaskMilestoneRow[]) ?? []));
      setLoadedForTaskId(taskId);
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
          queryName: 'taskMilestones.byTask',
          params: [taskId],
          subscriptionId,
        })
        .catch(() => {
          if (activeSubIdRef.current === subscriptionId) {
            setLoadedForTaskId(taskId);
          }
        });
    };

    const unsubReconnect = getHub()?.onConnection((state) => {
      if (state !== 'connected') return;
      if (activeSubIdRef.current !== subscriptionId) return;
      setLoadedForTaskId(null);
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
  }, [getHub, isConnected, onEvent, request, taskId]);

  const hasTask = taskId != null;

  return {
    rows,
    isLoading: hasTask && isConnected && loadedForTaskId !== taskId,
    isReconnecting: hasTask && !isConnected,
  };
}
