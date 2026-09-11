import type { TaskCore, TaskLifecycleStatus } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import { isValidTaskTransition } from './transitions.ts';

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

type Rejection = 'unsupported_status' | 'invalid_transition' | 'result_requires_done';
type Gate = { value: StandaloneTaskTransitionInput } | { reason: Rejection };

function requireManualStates(task: TaskCore, input: StandaloneTaskTransitionInput): Gate {
  return STANDALONE_TASK_STATUSES.some((status) => status === task.status) &&
    STANDALONE_TASK_STATUSES.includes(input.status)
    ? { value: input }
    : { reason: 'unsupported_status' };
}

function requireValidTransition(task: TaskCore, input: StandaloneTaskTransitionInput): Gate {
  return isValidTaskTransition(task.status, input.status)
    ? { value: input }
    : { reason: 'invalid_transition' };
}

function requireCompletionResult(input: StandaloneTaskTransitionInput): Gate {
  return input.result === undefined || input.status === 'done'
    ? { value: input }
    : { reason: 'result_requires_done' };
}

function buildLifecyclePatch(
  task: TaskCore,
  input: StandaloneTaskTransitionInput,
  now: number
): StandaloneTaskLifecyclePatch {
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

export const planStandaloneTaskTransition = (
  superpipe({})('plan-standalone-task-transition') as PipelineAPI
)
  .input(['task', 'input', 'now'])
  .pipe(requireManualStates, ['task', 'input'], 'result:patch')
  .pipe(requireValidTransition, ['task', 'input'], 'result:patch')
  .pipe(requireCompletionResult, 'input', 'result:patch')
  .pipe(buildLifecyclePatch, ['task', 'input', 'now'], 'patch')
  .end('patch') as (
  task: TaskCore,
  input: StandaloneTaskTransitionInput,
  now: number
) => StandaloneTaskLifecyclePatch | Rejection;
