import { z } from 'zod';
import type { ListTasksInput, TaskListPage } from '../../storage/tasks/list-tasks.ts';
import { defineOperation } from './registry.ts';
import { TaskCoreSchema, TaskWithSpaceFieldsSchema } from './task-get.ts';

const cursorSchema = z.object({ createdAt: z.number(), id: z.string().min(1) }).strict();

export function createListTasksOperation(
  listTasks: (input: ListTasksInput) => TaskListPage | Promise<TaskListPage>
) {
  return defineOperation({
    name: 'task.list',
    description:
      'List task data, newest first. Defaults to standalone tasks excluding archived tasks. Supply spaceId to list tasks owned by a Space, status to filter, and before with nextCursor to continue. Default limit is 50; maximum is 100. A Space-owned task includes its Space fields (ownership, workflow, approval, and pending-completion state); a standalone task returns only core fields.',
    inputSchema: z
      .object({
        spaceId: z.string().min(1).optional(),
        status: TaskCoreSchema.shape.status.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        before: cursorSchema.optional(),
      })
      .strict()
      .default({}),
    resultSchema: z.object({
      tasks: z.array(TaskWithSpaceFieldsSchema),
      nextCursor: cursorSchema.nullable(),
    }),
    execute: async (input) => listTasks(input),
  });
}
