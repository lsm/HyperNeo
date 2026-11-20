import type { NodeExecution } from '@hyperneo/shared/types/space';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

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
  admitTask: (taskId: string, caller: OperationCaller) => boolean;
  taskRepo: NonNullable<TaskMemberRepositories['taskRepo']>;
  readCoreTask: (taskId: string) => TaskCore | null;
  nodeExecutionRepo: NonNullable<TaskMemberRepositories['nodeExecutionRepo']>;
}

type LocatedTask = { taskId: string; workflowRunId: string | null };
type TaskRoster = { taskId: string; workflowRunId: string | null; members: NodeExecution[] };

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
    workflowRunId: located.workflowRunId,
    members: located.workflowRunId
      ? nodeExecutionRepo.listByWorkflowRun(located.workflowRunId)
      : [],
  };
}

export function admitTaskMember(
  taskId: string,
  allowed: boolean
): { value: string } | { reason: null } {
  return allowed ? { value: taskId } : { reason: null };
}

export function createListTaskMembersOperation(deps: ListTaskMembersDependencies) {
  const readTaskMembers = (
    superpipe({
      admitTask: deps.admitTask.bind(deps),
      taskRepo: deps.taskRepo,
      readCoreTask: deps.readCoreTask,
      nodeExecutionRepo: deps.nodeExecutionRepo,
    })('task.member.list') as PipelineAPI
  )
    .input(['taskId', 'caller'])
    .pipe('admitTask', ['taskId', 'caller'], 'allowed')
    .pipe(admitTaskMember, ['taskId', 'allowed'], 'result:roster')
    .pipe(locateTask, ['taskRepo', 'readCoreTask', 'roster'], 'result:roster')
    .pipe(collectMembers, ['nodeExecutionRepo', 'roster'], 'roster')
    .end('roster') as (taskId: string, caller: OperationCaller) => TaskRoster | null;

  return defineOperation({
    name: 'task.member.list',
    description:
      'List the workflow members working a task. One record per execution slot, which is a workflow node paired with one agent, so a node configured with several agents contributes several members. Slots come back oldest first by creation time and then by id, each with the agent name, agent id, agent session id, per-slot status, result and timestamps. Returns null when the task does not exist or belongs to a Space the caller is not in, and an empty list when the task exists but is not backed by a workflow run.',
    inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
    resultSchema: z
      .object({
        taskId: z.string(),
        workflowRunId: z.string().nullable(),
        members: z.array(NodeExecutionSchema),
      })
      .nullable(),
    execute: async (input, caller) => readTaskMembers(input.taskId, caller),
  });
}
