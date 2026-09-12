import { z } from 'zod';
import type {
  transitionStandaloneTask,
  TransitionStandaloneTaskInput,
} from '../../storage/tasks/transition-task.ts';
import { STANDALONE_TASK_STATUSES } from '../tasks/standalone-lifecycle.ts';
import { defineOperation, type OperationDefinition } from './registry.ts';
import { TaskCoreSchema } from './task-get.ts';

type TransitionResult = ReturnType<typeof transitionStandaloneTask>;

export const StandaloneTransitionTaskInputSchema = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(STANDALONE_TASK_STATUSES),
    result: z.string().optional(),
  })
  .strict();

const STANDALONE_TRANSITION_TASK_DESCRIPTION =
  'Change a standalone task lifecycle state. in_progress tracks manual work without starting an agent. Supply result only for done. Returns updated core data, null for absent or Space-owned tasks, or unsupported_status, invalid_transition, or result_requires_done when rejected. Archived tasks cannot reopen.';

export interface TransitionTaskOperationOptions<Input> {
  inputSchema?: z.ZodType<Input>;
  description?: string;
}

export function createTransitionTaskOperation<Input>(
  transitionTask: (input: Input) => TransitionResult | Promise<TransitionResult>,
  options: { inputSchema: z.ZodType<Input>; description?: string }
): OperationDefinition;
export function createTransitionTaskOperation(
  transitionTask: (
    input: TransitionStandaloneTaskInput
  ) => TransitionResult | Promise<TransitionResult>,
  options?: { description?: string }
): OperationDefinition;
export function createTransitionTaskOperation<Input = TransitionStandaloneTaskInput>(
  transitionTask: (input: Input) => TransitionResult | Promise<TransitionResult>,
  options: TransitionTaskOperationOptions<Input> = {}
) {
  return defineOperation({
    name: 'task.transition',
    description: options.description ?? STANDALONE_TRANSITION_TASK_DESCRIPTION,
    inputSchema:
      options.inputSchema ?? (StandaloneTransitionTaskInputSchema as unknown as z.ZodType<Input>),
    resultSchema: z.union([
      TaskCoreSchema.nullable(),
      z.enum(['unsupported_status', 'invalid_transition', 'result_requires_done']),
    ]),
    execute: async (input) => transitionTask(input),
  });
}
