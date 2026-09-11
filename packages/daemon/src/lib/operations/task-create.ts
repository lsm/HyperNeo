import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { z } from 'zod';
import type { CreateStandaloneTaskInput } from '../../storage/tasks/create-task.ts';
import { defineOperation } from './registry.ts';
import { TaskCoreSchema } from './task-get.ts';

export function createCreateTaskOperation(
  createTask: (
    input: CreateStandaloneTaskInput,
    creatorSessionId: string | undefined
  ) => TaskCore | Promise<TaskCore>
) {
  return defineOperation({
    name: 'task.create',
    description:
      'Create an independent task in this daemon. Creates a work record without starting agent execution or attaching it to a Space.',
    inputSchema: z
      .object({
        title: z.string().trim().min(1),
        description: z.string().optional(),
        priority: TaskCoreSchema.shape.priority.optional(),
        labels: z.array(z.string()).optional(),
      })
      .strict(),
    resultSchema: TaskCoreSchema,
    execute: async (input, caller) => createTask(input, caller.sessionId),
  });
}
