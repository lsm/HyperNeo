import { isRateOrUsageLimited, type SpaceTask } from '@hyperneo/shared';

export type ActionRequiredTaskInput = Pick<SpaceTask, 'status'>;

export function isActionRequired(task: ActionRequiredTaskInput): boolean {
  return task.status === 'blocked' || task.status === 'review' || isRateOrUsageLimited(task.status);
}

export function isActiveTask(task: ActionRequiredTaskInput): boolean {
  return (
    task.status === 'open' ||
    task.status === 'in_progress' ||
    task.status === 'approved' ||
    task.status === 'stopped'
  );
}

export function isDraftTask(task: ActionRequiredTaskInput): boolean {
  return task.status === 'draft';
}
