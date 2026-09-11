import type { TaskLifecycleStatus } from '@hyperneo/shared/types/task-core';

export const VALID_TASK_TRANSITIONS: Record<TaskLifecycleStatus, TaskLifecycleStatus[]> = {
  draft: ['open', 'archived'],
  open: ['in_progress', 'blocked', 'review', 'done', 'cancelled', 'archived'],
  in_progress: [
    'open',
    'review',
    'approved',
    'done',
    'blocked',
    'cancelled',
    'stopped',
    'rate_limited',
    'usage_limited',
  ],
  review: ['done', 'approved', 'in_progress', 'cancelled', 'archived', 'stopped'],
  approved: ['done', 'in_progress', 'archived', 'cancelled'],
  done: ['open', 'in_progress', 'archived'],
  blocked: ['open', 'in_progress', 'review', 'done', 'cancelled', 'archived', 'stopped'],
  cancelled: ['open', 'in_progress', 'done', 'archived'],
  rate_limited: [
    'in_progress',
    'usage_limited',
    'open',
    'blocked',
    'cancelled',
    'archived',
    'stopped',
  ],
  usage_limited: [
    'in_progress',
    'rate_limited',
    'open',
    'blocked',
    'cancelled',
    'archived',
    'stopped',
  ],
  archived: [],
  stopped: ['in_progress', 'open', 'review', 'cancelled', 'archived'],
};

export function isValidTaskTransition(from: TaskLifecycleStatus, to: TaskLifecycleStatus): boolean {
  return VALID_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertValidTaskTransition(
  from: TaskLifecycleStatus,
  to: TaskLifecycleStatus
): void {
  if (!isValidTaskTransition(from, to)) {
    throw new Error(
      `Invalid status transition from '${from}' to '${to}'. ` +
        `Allowed: ${VALID_TASK_TRANSITIONS[from]?.join(', ') || 'none'}`
    );
  }
}
