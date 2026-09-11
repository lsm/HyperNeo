import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { z } from 'zod';
import type { OperationCaller } from './registry.ts';
import type { TaskMetadataInput } from './task-metadata.ts';
import { defineOperation } from './registry.ts';
import { TaskCoreSchema } from './task-get.ts';

export function createUpdateTaskOperation(
  editTask: (
    input: TaskMetadataInput,
    caller: OperationCaller
  ) => TaskCore | null | Promise<TaskCore | null>
) {
  return defineOperation({
    name: 'task.update',
    description:
      'Edit standalone task metadata. Supply taskId and at least one of title, description, priority or labels. Omitted fields are preserved. Returns null for absent or Space-owned tasks. Does not change lifecycle or execution.',
    inputSchema: z
      .object({
        taskId: z.string().min(1),
        title: z.string().trim().min(1).optional(),
        description: z.string().optional(),
        priority: TaskCoreSchema.shape.priority.optional(),
        labels: z.array(z.string()).optional(),
      })
      .strict()
      .refine(
        (input) =>
          [input.title, input.description, input.priority, input.labels].some(
            (value) => value !== undefined
          ),
        'Task update requires at least one editable field'
      ),
    resultSchema: TaskCoreSchema.nullable(),
    execute: async (input, caller) => editTask(input, caller),
  });
}
