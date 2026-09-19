import { TaskMutationDenialSchema, type TaskMutationDenial } from './mutation-denial.ts';
import { z } from 'zod';
import type {
  TransitionStandaloneTaskInput,
  transitionStandaloneTask,
} from '../../storage/tasks/transition-task.ts';
import { STANDALONE_TASK_STATUSES } from './standalone-lifecycle.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import { TaskWithSpaceFieldsSchema } from './get-operation.ts';

type TransitionResult = ReturnType<typeof transitionStandaloneTask>;

export type TransitionTaskRejection =
  | 'unsupported_status'
  | 'invalid_transition'
  | 'result_requires_done'
  | 'block_reason_requires_blocked'
  | 'space_at_task_capacity';

export type TransitionTaskOutput = TransitionResult | TransitionTaskRejection | TaskMutationDenial;

export const StandaloneTransitionTaskInputSchema = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(STANDALONE_TASK_STATUSES),
    result: z.string().optional(),
    expectedStatus: z.enum(STANDALONE_TASK_STATUSES).optional(),
  })
  .strict();

const STANDALONE_TRANSITION_TASK_DESCRIPTION =
  'Change a standalone task lifecycle state. in_progress tracks manual work without starting an agent. Supply result only for done. Returns updated core data, null for absent or Space-owned tasks, or unsupported_status, invalid_transition, or result_requires_done when rejected. Supply expectedStatus to make the write conditional on the task still being in that state, which rejects with invalid_transition when another writer moved it first. Archived tasks cannot reopen.';

export interface TransitionTaskOperationOptions<Input> {
  inputSchema?: z.ZodType<Input>;
  description?: string;
}

export function createTransitionTaskOperation<Input>(
  transitionTask: (
    input: Input,
    caller: OperationCaller
  ) => TransitionTaskOutput | Promise<TransitionTaskOutput>,
  options: { inputSchema: z.ZodType<Input>; description?: string }
): OperationDefinition;
export function createTransitionTaskOperation(
  transitionTask: (
    input: TransitionStandaloneTaskInput,
    caller: OperationCaller
  ) => TransitionTaskOutput | Promise<TransitionTaskOutput>,
  options?: { description?: string }
): OperationDefinition;
export function createTransitionTaskOperation<Input = TransitionStandaloneTaskInput>(
  transitionTask: (
    input: Input,
    caller: OperationCaller
  ) => TransitionTaskOutput | Promise<TransitionTaskOutput>,
  options: TransitionTaskOperationOptions<Input> = {}
) {
  return defineOperation({
    name: 'task.transition',
    description: options.description ?? STANDALONE_TRANSITION_TASK_DESCRIPTION,
    inputSchema:
      options.inputSchema ?? (StandaloneTransitionTaskInputSchema as unknown as z.ZodType<Input>),
    resultSchema: z.union([
      TaskMutationDenialSchema,
      TaskWithSpaceFieldsSchema.nullable(),
      z.enum([
        'unsupported_status',
        'invalid_transition',
        'result_requires_done',
        'block_reason_requires_blocked',
        'space_at_task_capacity',
      ]),
    ]),
    execute: async (input, caller) => transitionTask(input, caller),
  });
}
