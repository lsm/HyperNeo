import {
  MAX_SPACE_CONCURRENT_TASKS,
  MIN_SPACE_CONCURRENT_TASKS,
  isRateOrUsageLimited,
  type Space,
  type SpaceTask,
} from '@hyperneo/shared';

export function availableTaskSlots(space: Space | null, tasks: SpaceTask[]): number {
  if (!space) return 0;
  const configured = space.maxConcurrentTasks ?? space.config?.maxConcurrentTasks;
  const limit =
    configured === undefined || !Number.isFinite(configured)
      ? MIN_SPACE_CONCURRENT_TASKS
      : Math.min(
          MAX_SPACE_CONCURRENT_TASKS,
          Math.max(MIN_SPACE_CONCURRENT_TASKS, Math.trunc(configured))
        );
  const running = tasks.filter(
    (task) =>
      task.status === 'in_progress' ||
      task.status === 'approved' ||
      isRateOrUsageLimited(task.status)
  ).length;
  return Math.max(0, limit - running);
}
