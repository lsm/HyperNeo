import { TaskMutationDenialSchema, type TaskMutationDenial } from './mutation-denial.ts';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';
import type { TaskMetadataInput } from './metadata-editor.ts';
import { defineOperation } from '../operations/registry.ts';
import { TaskCoreSchema, TaskWithSpaceFieldsSchema } from './get-operation.ts';

export function createUpdateTaskOperation(
  editTask: (
    input: TaskMetadataInput,
    caller: OperationCaller
  ) => TaskCore | TaskMutationDenial | null | Promise<TaskCore | TaskMutationDenial | null>
) {
  return defineOperation({
    name: 'task.update',
    description:
      'Edit available task metadata. Space-scoped MCP callers can edit tasks in their owning Space. Supply taskId and at least one of title, description, priority or labels. Omitted fields are preserved. Returns null for missing targets and { accepted: false, reason: "task_update_denied" } for caller scope denials. Does not change lifecycle or execution.',
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
    resultSchema: z.union([TaskWithSpaceFieldsSchema.nullable(), TaskMutationDenialSchema]),
    execute: async (input, caller) => editTask(input, caller),
  });
}
