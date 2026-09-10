import type { TaskCore, TaskLifecycleStatus } from '@hyperneo/shared/types/task-core';
import { z } from 'zod';
import { VALID_TASK_TRANSITIONS } from '../tasks/transitions.ts';
import { defineOperation } from './registry.ts';

export const TaskCoreSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(Object.keys(VALID_TASK_TRANSITIONS) as TaskLifecycleStatus[]),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  labels: z.array(z.string()),
  dependsOn: z.array(z.string()),
  result: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  updatedAt: z.number(),
}) satisfies z.ZodType<TaskCore>;

export function createGetTaskOperation(
  readTask: (taskId: string) => TaskCore | null | Promise<TaskCore | null>
) {
  return defineOperation({
    name: 'task.get',
    description:
      'Read core task data by its global task ID. Returns null when absent. Does not include ownership or execution details.',
    inputSchema: z.object({ taskId: z.string().min(1) }),
    resultSchema: TaskCoreSchema.nullable(),
    execute: async (input) => readTask(input.taskId),
  });
}
