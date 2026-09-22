import { TaskMutationDenialSchema, type TaskMutationDenial } from './mutation-denial.ts';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';
import type { TaskDependencyRejection, TaskMetadataInput } from './metadata-editor.ts';
import { defineOperation } from '../operations/registry.ts';
import { TaskCoreSchema, TaskWithSpaceFieldsSchema } from './get-operation.ts';

type UpdateTaskResult = TaskCore | TaskMutationDenial | TaskDependencyRejection | null;

export function createUpdateTaskOperation(
  editTask: (
    input: TaskMetadataInput,
    caller: OperationCaller
  ) => UpdateTaskResult | Promise<UpdateTaskResult>
) {
  return defineOperation({
    name: 'task.update',
    description:
      'Edit available task metadata and dependencies. Space-scoped MCP callers can edit tasks in their owning Space while their session is active. Supply taskId and at least one of title, description, priority, labels or dependsOn. Omitted fields are preserved. dependsOn replaces the whole dependency list rather than adding to it, so send every prerequisite you want to keep; an omitted ID is removed and an empty array clears the list. Dependencies must belong to the same owner as the task; adding an unmet dependency to a running task blocks it and stops its execution. Returns null for missing targets and { accepted: false, reason: "task_update_denied" } when the calling MCP session is not active in the owning Space. Standalone dependency validation returns a rejection code; Space dependency validation raises operation errors and preserves duplicate IDs. A call that changes dependsOn together with other fields writes them separately and not atomically: the dependency replacement commits and emits first, so an error from the metadata write leaves the new dependencies in place, including their blocking effect on a running task. Retrying the same input reconciles both. Does not change lifecycle otherwise.',
    inputSchema: z
      .object({
        taskId: z.string().min(1),
        title: z.string().trim().min(1).optional(),
        description: z.string().optional(),
        priority: TaskCoreSchema.shape.priority.optional(),
        labels: z.array(z.string()).optional(),
        dependsOn: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .refine(
        (input) =>
          [input.title, input.description, input.priority, input.labels, input.dependsOn].some(
            (value) => value !== undefined
          ),
        'Task update requires at least one editable field'
      ),
    resultSchema: z.union([
      TaskWithSpaceFieldsSchema.nullable(),
      TaskMutationDenialSchema,
      z.enum([
        'task_not_found',
        'self_dependency',
        'duplicate_dependency',
        'dependency_not_found',
        'dependency_cycle',
      ]),
    ]),
    execute: async (input, caller) => editTask(input, caller),
  });
}
