import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { z } from 'zod';
import type { CreateStandaloneTaskInput } from '../../storage/tasks/create-task.ts';
import { defineOperation, type OperationDefinition } from './registry.ts';
import { TaskCoreSchema } from './task-get.ts';

export const StandaloneCreateTaskInputSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().optional(),
    priority: TaskCoreSchema.shape.priority.optional(),
    labels: z.array(z.string()).optional(),
  })
  .strict();

const STANDALONE_CREATE_TASK_DESCRIPTION =
  'Create an independent task in this daemon. Creates a work record without starting agent execution or attaching it to a Space.';

export interface CreateTaskOperationOptions<Input> {
  inputSchema?: z.ZodType<Input>;
  description?: string;
}

export function createCreateTaskOperation<Input>(
  createTask: (input: Input, creatorSessionId: string | undefined) => TaskCore | Promise<TaskCore>,
  options: { inputSchema: z.ZodType<Input>; description?: string }
): OperationDefinition;
export function createCreateTaskOperation(
  createTask: (
    input: CreateStandaloneTaskInput,
    creatorSessionId: string | undefined
  ) => TaskCore | Promise<TaskCore>,
  options?: { description?: string }
): OperationDefinition;
export function createCreateTaskOperation<Input = CreateStandaloneTaskInput>(
  createTask: (input: Input, creatorSessionId: string | undefined) => TaskCore | Promise<TaskCore>,
  options: CreateTaskOperationOptions<Input> = {}
) {
  return defineOperation({
    name: 'task.create',
    description: options.description ?? STANDALONE_CREATE_TASK_DESCRIPTION,
    inputSchema:
      options.inputSchema ?? (StandaloneCreateTaskInputSchema as unknown as z.ZodType<Input>),
    resultSchema: TaskCoreSchema,
    execute: async (input, caller) => createTask(input, caller.sessionId),
  });
}
