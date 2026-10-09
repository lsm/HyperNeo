import type { TaskLifecycleStatus } from './task-core.ts';

export const VALID_TASK_TRANSITIONS: Record<TaskLifecycleStatus, TaskLifecycleStatus[]> = {
  draft: ['open', 'done', 'cancelled', 'archived'],
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
    'archived',
  ],
  review: ['done', 'approved', 'in_progress', 'cancelled', 'archived', 'stopped'],
  approved: ['done', 'in_progress', 'archived', 'cancelled'],
  done: ['open', 'in_progress', 'cancelled', 'archived'],
  blocked: ['open', 'in_progress', 'review', 'done', 'cancelled', 'archived', 'stopped'],
  cancelled: ['open', 'in_progress', 'done', 'archived'],
  rate_limited: [
    'in_progress',
    'usage_limited',
    'open',
    'blocked',
    'done',
    'cancelled',
    'archived',
    'stopped',
  ],
  usage_limited: [
    'in_progress',
    'rate_limited',
    'open',
    'blocked',
    'done',
    'cancelled',
    'archived',
    'stopped',
  ],
  archived: [],
  stopped: ['in_progress', 'open', 'review', 'done', 'cancelled', 'archived'],
};

export function isValidTaskTransition(from: TaskLifecycleStatus, to: TaskLifecycleStatus): boolean {
  return VALID_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

const RUNTIME_OWNED_TARGETS: readonly TaskLifecycleStatus[] = [
  'approved',
  'rate_limited',
  'usage_limited',
];

export function humanTaskTransitionTargets(from: TaskLifecycleStatus): TaskLifecycleStatus[] {
  return (VALID_TASK_TRANSITIONS[from] ?? []).filter(
    (target) => !RUNTIME_OWNED_TARGETS.includes(target)
  );
}
