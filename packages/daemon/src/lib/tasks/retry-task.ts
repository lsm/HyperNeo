import type { Session, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationCallerRole,
} from '../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';
import { routeRetryTask } from '../space/tools/task-transition-routing.ts';
import { TaskWithSpaceFieldsSchema } from './get-operation.ts';
import { resolveMetadataSessionSpace, resolveSpaceTaskOwner } from './metadata.ts';
import type { SpaceTaskManager } from './task-manager.ts';

const inputSchema = z
  .object({ taskId: z.string().min(1), description: z.string().optional() })
  .strict();
type Input = z.infer<typeof inputSchema>;
export type RetryTaskRejection =
  | 'task_not_found'
  | 'task_not_in_space'
  | 'status_not_retryable'
  | 'retry_denied'
  | 'retry_unavailable';
type Rejection = RetryTaskRejection;
type Result = SpaceTask | Rejection;
type RetryPlan = { task: SpaceTask; recoverTo?: 'open' | 'in_progress' };

const RETRY_ROLES: readonly OperationCallerRole[] = ['long_term_agent'];
const RETRYABLE_STATUSES: ReadonlySet<string> = new Set(['blocked', 'cancelled', 'done']);

export interface RetryTaskDependencies extends SpaceMcpSessionPolicyContext {
  getSession: (sessionId: string) => Session | null;
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'retryTask'>;
  recoverWorkflowTask?: (
    spaceId: string,
    taskId: string,
    targetStatus: 'open' | 'in_progress',
    options: { description?: string }
  ) => Promise<SpaceTask | string>;
}

export function admitRetrier(
  db: Database,
  input: Input,
  caller: OperationCaller,
  tasks: RetryTaskDependencies
): { value: SpaceTask } | { reason: Rejection } {
  const owner = resolveSpaceTaskOwner(db, input.taskId);
  if (owner === null) return { reason: 'task_not_found' };
  if (owner.kind === 'standalone') return { reason: 'task_not_in_space' };
  if (caller.source === 'mcp') {
    const session = caller.sessionId ? tasks.getSession(caller.sessionId) : null;
    if (
      session?.status !== 'active' ||
      resolveMetadataSessionSpace(session, tasks) !== owner.spaceId
    ) {
      return { reason: 'retry_denied' };
    }
  }
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  return task ? { value: task } : { reason: 'task_not_found' };
}

export function routeRetry(task: SpaceTask): { value: RetryPlan } | { reason: Rejection } {
  if (!RETRYABLE_STATUSES.has(task.status)) return { reason: 'status_not_retryable' };
  const plan = routeRetryTask({
    taskExists: true,
    taskInSpace: true,
    currentStatus: task.status,
    hasWorkflowRun: task.workflowRunId != null,
    taskId: task.id,
  });
  if (plan.action === 'reject') return { reason: 'status_not_retryable' };
  return {
    value:
      plan.action === 'recover_workflow_task' ? { task, recoverTo: plan.targetStatus } : { task },
  };
}

export async function applyRetry(
  plan: RetryPlan,
  input: Input,
  tasks: RetryTaskDependencies
): Promise<Result> {
  if (plan.recoverTo === undefined) {
    return tasks
      .getTaskManager(plan.task.spaceId)
      .retryTask(plan.task.id, { description: input.description });
  }
  if (!tasks.recoverWorkflowTask) return 'retry_unavailable';
  const recovered = await tasks.recoverWorkflowTask(
    plan.task.spaceId,
    plan.task.id,
    plan.recoverTo,
    {
      description: input.description,
    }
  );
  return typeof recovered === 'string' ? 'retry_unavailable' : recovered;
}

const RETRY_TASK_DESCRIPTION =
  'Retry a Space task that stopped in blocked, cancelled, or done so it runs again — blocked tasks reopen as open, cancelled and done tasks resume as in_progress, and an optional description replaces the task brief for the new attempt. Workflow-backed tasks are handed to the workflow runtime for recovery; every other task is retried directly. RPC and internal callers, and MCP sessions that are active in the owning Space, are admitted; other MCP callers are rejected with retry_denied. Rejects task_not_found when the task is absent, task_not_in_space when it is standalone rather than Space-owned, status_not_retryable when the task is in any other status, and retry_unavailable when the workflow runtime cannot recover it. Returns the retried task on success.';

export function createRetryTaskOperation(
  getDatabase: () => Database,
  tasks: RetryTaskDependencies
) {
  const retry = (superpipe({ getDatabase, tasks })('retry-space-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitRetrier, ['db', 'input', 'caller', 'tasks'], 'result:outcome')
    .pipe(routeRetry, 'outcome', 'result:outcome')
    .pipe(applyRetry, ['outcome', 'input', 'tasks'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'task.retry',
    description: RETRY_TASK_DESCRIPTION,
    policy: { safetyClass: 'mutate', roles: RETRY_ROLES },
    inputSchema,
    resultSchema: z.union([
      TaskWithSpaceFieldsSchema,
      z.enum([
        'task_not_found',
        'task_not_in_space',
        'status_not_retryable',
        'retry_denied',
        'retry_unavailable',
      ]),
    ]),
    execute: async (input, caller) => retry(input, caller),
  });
}
