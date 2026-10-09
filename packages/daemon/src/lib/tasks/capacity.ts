import {
  MAX_SPACE_CONCURRENT_TASKS,
  MIN_SPACE_CONCURRENT_TASKS,
  type Space,
  type SpaceTaskStatus,
} from '@hyperneo/shared';

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
