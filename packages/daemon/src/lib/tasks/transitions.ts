import type { TaskLifecycleStatus } from '@hyperneo/shared/types/task-core';
import {
  VALID_TASK_TRANSITIONS,
  isValidTaskTransition,
} from '@hyperneo/shared/types/task-transitions';

export { VALID_TASK_TRANSITIONS, isValidTaskTransition };

export type TaskRejectionKind =
  | 'task_not_found'
  | 'invalid_transition'
  | 'checkpoint_not_refreshable'
  | 'direct_start_queued';

export class TaskRejection extends Error {
  constructor(
    readonly kind: TaskRejectionKind,
    message: string
  ) {
    super(message);
    this.name = 'TaskRejection';
  }
}

export function taskRejectionKind(error: unknown): TaskRejectionKind | undefined {
  return error instanceof TaskRejection ? error.kind : undefined;
}

export function assertValidTaskTransition(
  from: TaskLifecycleStatus,
  to: TaskLifecycleStatus
): void {
  if (!isValidTaskTransition(from, to)) {
    throw new TaskRejection(
      'invalid_transition',
      `Invalid status transition from '${from}' to '${to}'. ` +
        `Allowed: ${VALID_TASK_TRANSITIONS[from]?.join(', ') || 'none'}`
    );
  }
}

const RETRYABLE_TASK_STATUSES: ReadonlySet<string> = new Set(['blocked', 'cancelled', 'done']);

export function isRetryableTaskStatus(status: string): boolean {
  return RETRYABLE_TASK_STATUSES.has(status);
}

export function retryTargetStatus(status: string): 'open' | 'in_progress' {
  return status === 'blocked' ? 'open' : 'in_progress';
}

export function assertQueuedTaskRetryTransition(from: TaskLifecycleStatus): void {
  if (from === 'review') return;
  assertValidTaskTransition(from, 'open');
}
