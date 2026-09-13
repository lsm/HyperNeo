import { z } from 'zod';
import type { ListTasksInput, TaskListPage } from '../../storage/tasks/list-tasks.ts';
import { defineOperation, type OperationCaller } from './registry.ts';
import { BlockReasonSchema, TaskCoreSchema, TaskWithSpaceFieldsSchema } from './task-get.ts';

const cursorSchema = z.object({ createdAt: z.number(), id: z.string().min(1) }).strict();

export function createListTasksOperation(
  listTasks: (
    input: ListTasksInput,
    caller: OperationCaller
  ) => TaskListPage | Promise<TaskListPage>
) {
  return defineOperation({
    name: 'task.list',
    description:
      'List task data, newest first. Defaults to standalone tasks excluding archived tasks. Supply spaceId to list tasks owned by a Space, status to filter, and before with nextCursor to continue. Default limit is 50; maximum is 100. total is the count of every task matching the filters, ignoring all pagination (limit, offset and before). Ordering is newest-first by creation time; pass orderBy updatedAt for most-recently-touched first, which pages by offset only and always returns nextCursor null. Prefer before with nextCursor for sequential paging; offset exists for random-access page jumps and skips that many matches. blockReason narrows to tasks blocked for that reason, or to tasks with no reason recorded when null; blockReasonNotIn excludes the listed reasons and keeps tasks with no reason. Both require status blocked, and the two are mutually exclusive. A Space-owned task includes its Space fields (ownership, workflow, approval, and pending-completion state); a standalone task returns only core fields.',
    inputSchema: z
      .object({
        spaceId: z.string().min(1).optional(),
        status: TaskCoreSchema.shape.status.optional(),
        blockReason: BlockReasonSchema.nullable().optional(),
        blockReasonNotIn: BlockReasonSchema.array().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        orderBy: z.enum(['createdAt', 'updatedAt']).optional(),
        before: cursorSchema.optional(),
      })
      .strict()
      .refine((input) => input.blockReason === undefined || input.blockReasonNotIn === undefined, {
        message: 'blockReason and blockReasonNotIn are mutually exclusive',
        path: ['blockReasonNotIn'],
      })
      .refine((input) => input.orderBy !== 'updatedAt' || input.before === undefined, {
        message:
          'before cursors key on createdAt and cannot page an updatedAt ordering; use offset',
        path: ['before'],
      })
      .refine(
        (input) =>
          (input.blockReason === undefined && input.blockReasonNotIn === undefined) ||
          input.status === 'blocked',
        {
          message: "blockReason and blockReasonNotIn require status === 'blocked'",
          path: ['status'],
        }
      )
      .default({}),
    resultSchema: z.object({
      tasks: z.array(TaskWithSpaceFieldsSchema),
      total: z.number().int().min(0),
      nextCursor: cursorSchema.nullable(),
    }),
    execute: async (input, caller) => listTasks(input, caller),
  });
}
