import {
  MAX_SPACE_CONCURRENT_TASKS,
  MIN_SPACE_CONCURRENT_TASKS,
  type Space,
  type SpaceTask,
  type SpaceTaskStatus,
} from '@hyperneo/shared';
import { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';

export const TASK_SLOT_STATUSES: readonly SpaceTaskStatus[] = [
  'in_progress',
  'approved',
  'rate_limited',
  'usage_limited',
];

export function occupiesTaskSlot(status: SpaceTaskStatus): boolean {
  return TASK_SLOT_STATUSES.includes(status);
}

export function availableTaskSlots(space: Space | null, running: number): number {
  if (!space) return 0;
  const configured = space.maxConcurrentTasks ?? space.config?.maxConcurrentTasks;
  const limit =
    configured === undefined || !Number.isFinite(configured)
      ? MIN_SPACE_CONCURRENT_TASKS
      : Math.min(
          MAX_SPACE_CONCURRENT_TASKS,
          Math.max(MIN_SPACE_CONCURRENT_TASKS, Math.trunc(configured))
        );
  return Math.max(0, limit - running);
}

export interface TaskSlotUsage {
  space: Space | null;
  running: number;
}

export function claimsTaskSlot(
  target: SpaceTaskStatus,
  task: Pick<SpaceTask, 'status' | 'workflowRunId' | 'taskAgentSessionId'>
): boolean {
  return (
    target === 'in_progress' &&
    !occupiesTaskSlot(task.status) &&
    !task.workflowRunId &&
    !task.taskAgentSessionId
  );
}

export function readTaskSlotUsage(db: Database, spaceId: string): TaskSlotUsage {
  return {
    space: new SpaceRepository(db).getSpace(spaceId),
    running: new SpaceTaskRepository(db).countByStatuses(spaceId, TASK_SLOT_STATUSES),
  };
}

export function guardTaskSlot(
  db: Database,
  target: SpaceTaskStatus
): (current: SpaceTask) => 'space_at_task_capacity' | undefined {
  return (current) =>
    claimsTaskSlot(target, current) &&
    'reason' in requireTaskSlot(current, readTaskSlotUsage(db, current.spaceId))
      ? 'space_at_task_capacity'
      : undefined;
}

export function requireTaskSlot<T>(
  subject: T,
  usage: TaskSlotUsage | null
): { value: T } | { reason: 'space_at_task_capacity' } {
  return !usage || availableTaskSlots(usage.space, usage.running) > 0
    ? { value: subject }
    : { reason: 'space_at_task_capacity' };
}
