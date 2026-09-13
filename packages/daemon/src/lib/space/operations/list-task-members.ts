import type { NodeExecution } from '@hyperneo/shared/types/space';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
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

export interface TaskMemberRepositories {
  taskRepo?: Pick<SpaceTaskRepository, 'getTask'>;
  nodeExecutionRepo?: Pick<NodeExecutionRepository, 'listByWorkflowRun'>;
}

export interface ListTaskMembersDependencies {
  taskRepo: NonNullable<TaskMemberRepositories['taskRepo']>;
  readCoreTask: (taskId: string) => TaskCore | null;
  nodeExecutionRepo: NonNullable<TaskMemberRepositories['nodeExecutionRepo']>;
}

type LocatedTask = { taskId: string; workflowRunId: string | null };
type TaskRoster = { taskId: string; members: NodeExecution[] };

function locateTask(
  taskRepo: ListTaskMembersDependencies['taskRepo'],
  readCoreTask: ListTaskMembersDependencies['readCoreTask'],
  taskId: string
): { value: LocatedTask } | { reason: null } {
  const spaceTask = taskRepo.getTask(taskId);
  if (spaceTask) return { value: { taskId, workflowRunId: spaceTask.workflowRunId ?? null } };
  return readCoreTask(taskId) ? { value: { taskId, workflowRunId: null } } : { reason: null };
}

function collectMembers(
  nodeExecutionRepo: ListTaskMembersDependencies['nodeExecutionRepo'],
  located: LocatedTask
): TaskRoster {
  return {
    taskId: located.taskId,
    members: located.workflowRunId
      ? nodeExecutionRepo.listByWorkflowRun(located.workflowRunId)
      : [],
  };
}

export const readTaskMembers = (superpipe({})('read-task-members') as PipelineAPI)
  .input(['taskRepo', 'readCoreTask', 'nodeExecutionRepo', 'taskId'])
  .pipe(locateTask, ['taskRepo', 'readCoreTask', 'taskId'], 'result:roster')
  .pipe(collectMembers, ['nodeExecutionRepo', 'roster'], 'roster')
  .end('roster') as (
  taskRepo: ListTaskMembersDependencies['taskRepo'],
  readCoreTask: ListTaskMembersDependencies['readCoreTask'],
  nodeExecutionRepo: ListTaskMembersDependencies['nodeExecutionRepo'],
  taskId: string
) => TaskRoster | null;

export function createListTaskMembersOperation(deps: ListTaskMembersDependencies) {
  return defineOperation({
    name: 'task.members.list',
    description:
      'List the workflow members working a task. One record per execution slot, which is a workflow node paired with one agent, so a node configured with several agents contributes several members. Slots come back oldest first by creation time and then by id, each with the agent name, agent id, agent session id, per-slot status, result and timestamps. Returns null when the task does not exist, and an empty list when the task exists but is not backed by a workflow run.',
    inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
    resultSchema: z
      .object({ taskId: z.string(), members: z.array(NodeExecutionSchema) })
      .nullable(),
    execute: async (input) =>
      readTaskMembers(deps.taskRepo, deps.readCoreTask, deps.nodeExecutionRepo, input.taskId),
  });
}
