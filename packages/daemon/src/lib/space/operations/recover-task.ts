import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { Logger } from '../../logger.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { TaskWithSpaceFieldsSchema } from '../../operations/task-get.ts';
import { RETRYABLE_TASK_STATUSES, type SpaceTaskManager } from '../managers/space-task-manager.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import { routeRetryTask, type RetryTaskRouting } from '../tools/task-transition-routing.ts';
import {
  resolveMetadataSessionSpace,
  resolveSpaceTaskOwner,
  type SpaceTaskMetadataDependencies,
} from './task-metadata.ts';

const log = new Logger('RecoverSpaceTask');
const inputSchema = z
  .object({ taskId: z.string().min(1), description: z.string().optional() })
  .strict();
type Input = z.infer<typeof inputSchema>;
const REJECTIONS = [
  'task_not_found',
  'task_not_in_space',
  'status_not_retryable',
  'recovery_denied',
  'recovery_failed',
] as const;
type Rejection = (typeof REJECTIONS)[number];
type Result = SpaceTask | Rejection;
type Plan = Exclude<RetryTaskRouting, { action: 'reject' }>;
type Planned = { task: SpaceTask; plan: Plan };

export interface RecoverTaskDependencies extends SpaceMcpSessionPolicyContext {
  getSession: SpaceTaskMetadataDependencies['getSession'];
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'retryTask'>;
  emitTaskUpdated: SpaceTaskMetadataDependencies['emitTaskUpdated'];
  recoverWorkflowTask: (
    spaceId: string,
    taskId: string,
    targetStatus: 'open' | 'in_progress',
    description?: string
  ) => Promise<SpaceTask | string>;
}

export function admitRecovery(
  db: Database,
  input: Input,
  caller: OperationCaller,
  tasks: RecoverTaskDependencies
): { value: SpaceTask } | { reason: Rejection } {
  const owner = resolveSpaceTaskOwner(db, input.taskId);
  if (owner === null) return { reason: 'task_not_found' };
  if (owner.kind === 'standalone') return { reason: 'task_not_in_space' };
  if (caller.source === 'mcp') {
    const session = caller.sessionId ? tasks.getSession(caller.sessionId) : null;
    if (
      session?.status !== 'active' ||
      resolveMetadataSessionSpace(session, tasks) !== owner.spaceId
    )
      return { reason: 'recovery_denied' };
  }
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  return task ? { value: task } : { reason: 'task_not_found' };
}

export function planRecovery(task: SpaceTask): { value: Planned } | { reason: Rejection } {
  const plan = routeRetryTask({
    taskExists: true,
    taskInSpace: true,
    currentStatus: task.status,
    hasWorkflowRun: task.workflowRunId != null,
    taskId: task.id,
  });
  if (plan.action === 'reject') return { reason: plan.reason };
  if (plan.action === 'retry_task' && !RETRYABLE_TASK_STATUSES.includes(task.status))
    return { reason: 'status_not_retryable' };
  return { value: { task, plan } };
}

async function applyRecovery(
  planned: Planned,
  input: Input,
  tasks: RecoverTaskDependencies
): Promise<Result> {
  const { task, plan } = planned;
  if (plan.action === 'retry_task') {
    const retried = await tasks
      .getTaskManager(task.spaceId)
      .retryTask(task.id, { description: input.description });
    await tasks.emitTaskUpdated(task.spaceId, retried).catch((error: unknown) => {
      log.warn('Failed to emit space.task.updated:', error);
    });
    return retried;
  }
  const recovered = await tasks.recoverWorkflowTask(
    task.spaceId,
    task.id,
    plan.targetStatus,
    input.description
  );
  return typeof recovered === 'string' ? 'recovery_failed' : recovered;
}

const RECOVER_TASK_DESCRIPTION =
  'Retry a Space task that failed, was blocked, or was cancelled, optionally replacing its description for the new attempt. A workflow-backed task is recovered through its workflow run and reopens at open when it was blocked, otherwise at in_progress; a plain task is retried directly. RPC and internal callers, and MCP sessions active in the owning Space, are admitted; other MCP sessions are rejected with recovery_denied. Rejects task_not_found when the task is absent, task_not_in_space when it is standalone rather than Space-owned, status_not_retryable when the task is not blocked, cancelled or done, and recovery_failed when the workflow recovery itself refuses. Returns the reopened task on success.';

export function createRecoverTaskOperation(
  getDatabase: () => Database,
  tasks: RecoverTaskDependencies
) {
  const recover = (superpipe({ getDatabase, tasks })('recover-space-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitRecovery, ['db', 'input', 'caller', 'tasks'], 'result:outcome')
    .pipe(planRecovery, ['outcome'], 'result:outcome')
    .pipe(applyRecovery, ['outcome', 'input', 'tasks'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'task.recover',
    description: RECOVER_TASK_DESCRIPTION,
    inputSchema,
    resultSchema: z.union([TaskWithSpaceFieldsSchema, z.enum(REJECTIONS)]),
    execute: async (input, caller) => recover(input, caller),
  });
}
