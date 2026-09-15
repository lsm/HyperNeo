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
import { routeArchiveTask } from '../tools/task-transition-routing.ts';
import {
  resolveMetadataSessionSpace,
  resolveSpaceTaskOwner,
  type SpaceTaskMetadataDependencies,
} from './task-metadata.ts';

const log = new Logger('ArchiveSpaceTask');
const inputSchema = z.object({ taskId: z.string().min(1) }).strict();
type Input = z.infer<typeof inputSchema>;
export type ArchiveTaskRejection =
  | 'task_not_found'
  | 'task_not_in_space'
  | 'archive_active_run'
  | 'archive_denied';
type Rejection = ArchiveTaskRejection;
type Result = SpaceTask | Rejection;

export interface ArchiveTaskDependencies extends SpaceMcpSessionPolicyContext {
  getSession: SpaceTaskMetadataDependencies['getSession'];
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'archiveTask'>;
  emitTaskUpdated: SpaceTaskMetadataDependencies['emitTaskUpdated'];
  isWorkflowRunActive: (workflowRunId: string) => boolean;
}

export function admitArchiver(
  db: Database,
  input: Input,
  caller: OperationCaller,
  tasks: ArchiveTaskDependencies
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
      return { reason: 'archive_denied' };
  }
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  return task ? { value: task } : { reason: 'task_not_found' };
}

export function routeArchive(
  task: SpaceTask,
  tasks: ArchiveTaskDependencies
): { value: SpaceTask } | { reason: Rejection } {
  const workflowRunId = task.workflowRunId ?? undefined;
  const plan = routeArchiveTask({
    taskExists: true,
    taskInSpace: true,
    hasWorkflowRun: workflowRunId != null,
    runActive: workflowRunId != null ? tasks.isWorkflowRunActive(workflowRunId) : false,
    taskId: task.id,
    workflowRunId,
  });
  return plan.action === 'reject' ? { reason: plan.reason } : { value: task };
}

async function applyArchive(task: SpaceTask, tasks: ArchiveTaskDependencies): Promise<Result> {
  const updated = await tasks.getTaskManager(task.spaceId).archiveTask(task.id);
  await tasks.emitTaskUpdated(task.spaceId, updated).catch((error: unknown) => {
    log.warn('Failed to emit space.task.updated:', error);
  });
  return updated;
}

const ARCHIVE_TASK_DESCRIPTION =
  'Archive a Space task so it leaves the active board. RPC and internal callers, and MCP sessions active in the owning Space, are admitted; other MCP sessions are rejected with archive_denied. Rejects task_not_found when the task is absent, task_not_in_space when it is standalone rather than Space-owned, and archive_active_run when the task belongs to a workflow run that is still active — cancel the run instead, since archiving would leave it stranded. Returns the archived task on success.';

export function createArchiveTaskOperation(
  getDatabase: () => Database,
  tasks: ArchiveTaskDependencies
) {
  const archive = (superpipe({ getDatabase, tasks })('archive-space-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitArchiver, ['db', 'input', 'caller', 'tasks'], 'result:outcome')
    .pipe(routeArchive, ['outcome', 'tasks'], 'result:outcome')
    .pipe(applyArchive, ['outcome', 'tasks'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'task.archive',
    description: ARCHIVE_TASK_DESCRIPTION,
    inputSchema,
    resultSchema: z.union([
      TaskWithSpaceFieldsSchema,
      z.enum(['task_not_found', 'task_not_in_space', 'archive_active_run', 'archive_denied']),
    ]),
    execute: async (input, caller) => archive(input, caller),
  });
}
