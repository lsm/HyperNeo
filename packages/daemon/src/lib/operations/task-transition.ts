import { z } from 'zod';
import type {
  transitionStandaloneTask,
  TransitionStandaloneTaskInput,
} from '../../storage/tasks/transition-task.ts';
import { STANDALONE_TASK_STATUSES } from '../tasks/standalone-lifecycle.ts';
import { defineOperation } from './registry.ts';
import { TaskCoreSchema } from './task-get.ts';

type TransitionResult = ReturnType<typeof transitionStandaloneTask>;

export function createTransitionTaskOperation(
  transitionTask: (
    input: TransitionStandaloneTaskInput
  ) => TransitionResult | Promise<TransitionResult>
) {
  return defineOperation({
    name: 'task.transition',
    description:
      'Change a standalone task lifecycle state. in_progress tracks manual work without starting an agent. Supply result only for done. Returns updated core data, null for absent or Space-owned tasks, or unsupported_status, invalid_transition, or result_requires_done when rejected. Archived tasks cannot reopen.',
    inputSchema: z
      .object({
        taskId: z.string().min(1),
        status: z.enum(STANDALONE_TASK_STATUSES),
        result: z.string().optional(),
      })
      .strict(),
    resultSchema: z.union([
      TaskCoreSchema.nullable(),
      z.enum(['unsupported_status', 'invalid_transition', 'result_requires_done']),
    ]),
    execute: async (input) => transitionTask(input),
  });
}
