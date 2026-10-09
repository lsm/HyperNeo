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
      'Edit available task metadata and dependencies. Space-scoped MCP callers can edit tasks in their owning Space while their session is active. Supply taskId and at least one of title, description, priority, labels or dependsOn. Omitted fields are preserved. dependsOn replaces the whole dependency list rather than adding to it, so send every prerequisite you want to keep; an omitted ID is removed and an empty array clears the list. Dependencies must belong to the same owner as the task; adding an unmet dependency to a running task blocks it and stops its execution. Returns null for missing targets and { accepted: false, reason: "task_update_denied" } when the calling MCP session is not active in the owning Space. Space and standalone tasks share one dependency validator: a self, duplicate or missing dependency, a new dependency on a cancelled or archived task (dependency_ended), and a cycle are rejected. Standalone validation returns the rejection code; Space validation raises it as an operation error. dependsOn and the other fields are written together in one update. Does not change lifecycle otherwise.',
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
        'dependency_ended',
        'dependency_cycle',
      ]),
    ]),
    execute: async (input, caller) => editTask(input, caller),
  });
}
