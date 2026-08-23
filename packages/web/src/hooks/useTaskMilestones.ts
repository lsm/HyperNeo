import type {
  LiveQueryDeltaEvent,
  LiveQuerySnapshotEvent,
  TaskMilestoneRow,
} from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  createLiveQueryLifecycleState,
  type LiveQueryLifecycleEffect,
  type LiveQueryLifecycleEvent,
  type LiveQueryLifecycleState,
  transitionLiveQueryLifecycle,
} from '../lib/live-query-lifecycle';
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

type LifecycleStorePayload = LiveQuerySnapshotEvent | LiveQueryDeltaEvent | null;

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

    const initial = createLiveQueryLifecycleState({ snapshotRetryEnabled: false });
    let lifecycle: LiveQueryLifecycleState = initial.state;

    const dispatch = (event: LiveQueryLifecycleEvent): LiveQueryLifecycleEffect[] => {
      const result = transitionLiveQueryLifecycle(lifecycle, event);
      lifecycle = result.state;
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
          hub
            .request('liveQuery.subscribe', {
              queryName: 'taskMilestones.byTask',
              params: [taskId],
              subscriptionId,
            })
            .then(() => {
              executeEffects(dispatch({ type: 'subscribed', generation: effect.generation }));
            })
            .catch(() => {
              executeEffects(dispatch({ type: 'snapshot-failed', generation: effect.generation }));
            });
          continue;
        }
        if (effect.kind !== 'emit-to-store') continue;
        if (effect.emission.type === 'snapshot') {
          const snapshot = payload as LiveQuerySnapshotEvent | null;
          setRows(sortRows((snapshot?.rows as TaskMilestoneRow[]) ?? []));
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
      if (event.subscriptionId !== subscriptionId) return;
      executeEffects(
        dispatch({ type: 'snapshot-arrived', generation: lifecycle.generation }),
        event
      );
    });

    const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      executeEffects(dispatch({ type: 'delta-arrived', generation: lifecycle.generation }), event);
    });

    const unsubReconnect = getHub()?.onConnection((state) => {
      if (state !== 'connected') return;
      if (activeSubIdRef.current !== subscriptionId) return;
      setLoadedForTaskId(null);
      executeEffects(dispatch({ type: 'transport-error', generation: lifecycle.generation }));
    });

    return () => {
      executeEffects(dispatch({ type: 'unsubscribe' }));
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
