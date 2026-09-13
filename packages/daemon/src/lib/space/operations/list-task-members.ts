import type { NodeExecution } from '@hyperneo/shared/types/space';
import { z } from 'zod';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { defineOperation } from '../../operations/registry.ts';

export const NodeExecutionSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  workflowNodeId: z.string(),
  agentName: z.string(),
  agentId: z.string().nullable(),
  agentSessionId: z.string().nullable(),
  status: z.preprocess(
    (value) => (value === 'done' ? 'idle' : value),
    z.enum(['pending', 'in_progress', 'idle', 'waiting_rebind', 'blocked', 'cancelled'])
  ),
  result: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  updatedAt: z.number(),
  lastActivityAt: z.number().nullable(),
}) satisfies z.ZodType<NodeExecution>;

export interface ListTaskMembersDependencies {
  taskRepo?: Pick<SpaceTaskRepository, 'getTask'>;
  nodeExecutionRepo?: Pick<NodeExecutionRepository, 'listByWorkflowRun'>;
}

export function createListTaskMembersOperation(deps: ListTaskMembersDependencies) {
  return defineOperation({
    name: 'task.members.list',
    description:
      'List the workflow members working a task: one node execution per workflow node, oldest first by creation time and then by id, with the agent name, agent id, agent session id, per-node status, result and timestamps. Returns null when the task does not exist, and an empty list when the task exists but is not backed by a workflow run.',
    inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
    resultSchema: z
      .object({ taskId: z.string(), members: z.array(NodeExecutionSchema) })
      .nullable(),
    execute: async (input) => {
      const task = deps.taskRepo?.getTask(input.taskId);
      if (!task) return null;
      if (!task.workflowRunId) return { taskId: input.taskId, members: [] };
      const members = deps.nodeExecutionRepo?.listByWorkflowRun(task.workflowRunId) ?? [];
      return { taskId: input.taskId, members };
    },
  });
}
