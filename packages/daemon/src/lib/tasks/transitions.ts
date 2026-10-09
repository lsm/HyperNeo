import type { TaskLifecycleStatus } from '@hyperneo/shared/types/task-core';
import {
  VALID_TASK_TRANSITIONS,
  isValidTaskTransition,
} from '@hyperneo/shared/types/task-transitions';

export { VALID_TASK_TRANSITIONS, isValidTaskTransition };

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

export function assertQueuedTaskRetryTransition(from: TaskLifecycleStatus): void {
  if (from === 'review') return;
  assertValidTaskTransition(from, 'open');
}
