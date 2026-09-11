import type { TaskCore, TaskLifecycleStatus } from '@hyperneo/shared/types/task-core';
import { assertValidTaskTransition } from './transitions.ts';

export const STANDALONE_TASK_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
  'archived',
] as const satisfies readonly TaskLifecycleStatus[];

export type StandaloneTaskStatus = (typeof STANDALONE_TASK_STATUSES)[number];

export interface StandaloneTaskTransitionInput {
  status: StandaloneTaskStatus;
  result?: string;
}

export type StandaloneTaskLifecyclePatch = Pick<
  TaskCore,
  'status' | 'startedAt' | 'completedAt' | 'archivedAt' | 'result' | 'updatedAt'
>;

export function planStandaloneTaskTransition(
  task: TaskCore,
  input: StandaloneTaskTransitionInput,
  now: number
): StandaloneTaskLifecyclePatch {
  if (
    !STANDALONE_TASK_STATUSES.some((status) => status === task.status) ||
    !STANDALONE_TASK_STATUSES.includes(input.status)
  ) {
    throw new Error('Standalone task transitions require manual lifecycle states');
  }
  assertValidTaskTransition(task.status, input.status);
  if (input.result !== undefined && input.status !== 'done') {
    throw new Error('Task results may only be supplied when completing a task');
  }
  const reopening =
    (task.status === 'done' || task.status === 'cancelled') &&
    (input.status === 'open' || input.status === 'in_progress');
  return {
    status: input.status,
    startedAt:
      input.status === 'in_progress'
        ? now
        : reopening && input.status === 'open'
          ? null
          : task.startedAt,
    completedAt:
      input.status === 'done' || input.status === 'cancelled'
        ? now
        : input.status === 'open' || input.status === 'in_progress'
          ? null
          : task.completedAt,
    archivedAt: input.status === 'archived' ? now : task.archivedAt,
    result: input.result ?? (reopening ? null : task.result),
    updatedAt: now,
  };
}
