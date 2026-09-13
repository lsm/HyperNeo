import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { Logger } from '../../logger.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { TaskWithSpaceFieldsSchema } from '../../operations/task-get.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import { routePublishTask } from '../tools/task-transition-routing.ts';
import {
  admitActiveSpaceTaskCaller,
  resolveSpaceTaskOwner,
  type SpaceTaskMetadataDependencies,
} from './task-metadata.ts';

const log = new Logger('PublishSpaceTask');
const inputSchema = z.object({ taskId: z.string().min(1) }).strict();
type Input = z.infer<typeof inputSchema>;
type Rejection = 'task_not_found' | 'task_not_in_space' | 'not_draft' | 'publish_denied';
type Result = SpaceTask | Rejection;

export interface PublishTaskDependencies extends SpaceMcpSessionPolicyContext {
  getSession: SpaceTaskMetadataDependencies['getSession'];
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'publishTask'>;
  emitTaskUpdated: SpaceTaskMetadataDependencies['emitTaskUpdated'];
}

export function admitPublisher(
  db: Database,
  input: Input,
  caller: OperationCaller,
  tasks: PublishTaskDependencies
): { value: SpaceTask } | { reason: Rejection } {
  const owner = resolveSpaceTaskOwner(db, input.taskId);
  if (owner === null) return { reason: 'task_not_found' };
  if (owner.kind === 'standalone') return { reason: 'task_not_in_space' };
  if ('reason' in admitActiveSpaceTaskCaller(owner, caller, tasks))
    return { reason: 'publish_denied' };
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  return task ? { value: task } : { reason: 'task_not_found' };
}

export function routePublish(task: SpaceTask): { value: SpaceTask } | { reason: Rejection } {
  const plan = routePublishTask({
    taskExists: true,
    taskInSpace: true,
    currentStatus: task.status,
    taskId: task.id,
  });
  return plan.action === 'reject' ? { reason: plan.reason } : { value: task };
}

const LOST_PUBLISH_RACE = 'Only draft tasks can be published';

async function applyPublish(task: SpaceTask, tasks: PublishTaskDependencies): Promise<Result> {
  try {
    const updated = await tasks.getTaskManager(task.spaceId).publishTask(task.id);
    await tasks.emitTaskUpdated(task.spaceId, updated).catch((error: unknown) => {
      log.warn('Failed to emit space.task.updated:', error);
    });
    return updated;
  } catch (error) {
    if (error instanceof Error && error.message === LOST_PUBLISH_RACE) return 'not_draft';
    throw error;
  }
}

const PUBLISH_TASK_DESCRIPTION =
  'Publish a draft Space task so it becomes open and eligible for orchestration. RPC and internal callers, and MCP sessions active in the owning Space, are admitted; other MCP sessions are rejected with publish_denied. Rejects task_not_found when the task is absent, task_not_in_space when it is standalone rather than Space-owned, and not_draft when its current status is not draft. Returns the published task on success.';

export function createPublishTaskOperation(
  getDatabase: () => Database,
  tasks: PublishTaskDependencies
) {
  const publish = (superpipe({ getDatabase, tasks })('publish-space-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitPublisher, ['db', 'input', 'caller', 'tasks'], 'result:outcome')
    .pipe(routePublish, ['outcome'], 'result:outcome')
    .pipe(applyPublish, ['outcome', 'tasks'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'task.publish',
    description: PUBLISH_TASK_DESCRIPTION,
    inputSchema,
    resultSchema: z.union([
      TaskWithSpaceFieldsSchema,
      z.enum(['task_not_found', 'task_not_in_space', 'not_draft', 'publish_denied']),
    ]),
    execute: async (input, caller) => publish(input, caller),
  });
}
