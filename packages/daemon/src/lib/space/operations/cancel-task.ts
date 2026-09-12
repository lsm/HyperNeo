import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpaceTask } from '@hyperneo/shared';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';
import { resolveMetadataSessionSpace } from './task-metadata.ts';
import type { SpaceTaskDependencyDependencies } from './task-dependencies.ts';
import { Logger } from '../../logger.ts';
import {
  readDirectFinalizationRequest,
  type DirectFinalizationInput,
} from '../runtime/finalize-direct-attempt.ts';
import {
  enqueueDirectOutcome,
  type DirectOutcomeAcknowledgement,
} from '../runtime/direct-outcome-jobs.ts';
import { stopTaskExecution, type TaskStoppingExecutor } from '../../tasks/stop-task-execution.ts';

const log = new Logger('CancelTask');
const inputSchema = z.object({ taskId: z.string().min(1) }).strict();
type Input = z.infer<typeof inputSchema>;
export type CancelPolicyContext = SpaceMcpSessionPolicyContext &
  Pick<SpaceTaskDependencyDependencies, 'stopForStatus'> & {
    getTaskManager?: (spaceId: string) => Pick<SpaceTaskManager, 'setTaskStatus'>;
    emitTaskUpdated?: (spaceId: string, task: SpaceTask) => Promise<void>;
  };

const WORKFLOW_CANCELLATION_REJECTIONS: [substring: string, reason: string][] = [
  ['Invalid status transition from', 'cancellation_invalid_transition'],
];

function resolveWorkflowCancellationRejection(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : '';
  return WORKFLOW_CANCELLATION_REJECTIONS.find(([substring]) => message.includes(substring))?.[1];
}

async function admitManagedCancellation(
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: CancelPolicyContext
): Promise<{ value: undefined } | { reason: DirectOutcomeAcknowledgement }> {
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  if (!task?.spaceId || (task.taskAgentSessionId && !task.workflowRunId))
    return { value: undefined };
  if (task.archivedAt || task.status === 'cancelled' || task.status === 'done')
    return { reason: { accepted: false, reason: 'cancellation_unavailable' } };
  if (caller.source === 'mcp') {
    const session = caller.sessionId
      ? new SessionRepository(db).getSession(caller.sessionId)
      : null;
    if (
      session?.status !== 'active' ||
      resolveMetadataSessionSpace(session, policy) !== task.spaceId
    )
      return { reason: { accepted: false, reason: 'cancellation_denied' } };
  }
  if (task.workflowRunId) {
    const stopForStatus = policy.stopForStatus;
    if (!stopForStatus) return { reason: { accepted: false, reason: 'cancellation_unavailable' } };
    const executor: TaskStoppingExecutor<SpaceTask> = {
      stopForStatus: (taskId, targetStatus) =>
        stopForStatus(task.spaceId, taskId, { status: targetStatus }),
    };
    try {
      await stopTaskExecution(executor, task.id, 'cancelled');
      return { reason: { accepted: true, jobId: null } };
    } catch (error) {
      if (!resolveWorkflowCancellationRejection(error)) throw error;
      return { reason: { accepted: false, reason: 'cancellation_invalid_transition' } };
    }
  }
  const getTaskManager = policy.getTaskManager;
  if (!getTaskManager) return { reason: { accepted: false, reason: 'cancellation_unavailable' } };
  try {
    const updated = await getTaskManager(task.spaceId).setTaskStatus(task.id, 'cancelled', {
      onCascadedTasks: async (cascaded) => {
        for (const cascadedTask of cascaded) {
          await policy.emitTaskUpdated?.(task.spaceId, cascadedTask).catch((error: unknown) => {
            log.warn('Failed to emit space.task.updated:', error);
          });
        }
      },
    });
    await policy.emitTaskUpdated?.(task.spaceId, updated).catch((error: unknown) => {
      log.warn('Failed to emit space.task.updated:', error);
    });
    return { reason: { accepted: true, jobId: null } };
  } catch (error) {
    if (!resolveWorkflowCancellationRejection(error)) throw error;
    return { reason: { accepted: false, reason: 'cancellation_invalid_transition' } };
  }
}

function admitCancellation(
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: SpaceMcpSessionPolicyContext
): { value: DirectFinalizationInput } | { reason: DirectOutcomeAcknowledgement } {
  const unavailable = {
    reason: { accepted: false as const, reason: 'direct_cancellation_unavailable' },
  };
  const denied = {
    reason: { accepted: false as const, reason: 'direct_cancellation_denied' },
  };
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  if (!task?.spaceId || task.workflowRunId || !task.taskAgentSessionId || task.archivedAt)
    return unavailable;
  const row = db
    .prepare('SELECT id FROM direct_task_execution_attempts WHERE task_id = ? AND session_id = ?')
    .get(task.id, task.taskAgentSessionId) as { id: string } | null;
  const attempt = row ? new DirectTaskExecutionRepository(db).get(row.id) : null;
  if (!attempt) return unavailable;
  const target: DirectFinalizationInput = {
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    generation: attempt.generation,
    status: 'cancelled',
  };
  if (caller.source === 'mcp') {
    const session = caller.sessionId
      ? new SessionRepository(db).getSession(caller.sessionId)
      : null;
    const repeatOwnRequest =
      session?.id === attempt.sessionId &&
      session.type === 'worker' &&
      session.context?.taskId === task.id &&
      session.context.spaceId === task.spaceId &&
      readDirectFinalizationRequest(db, target)?.status === 'cancelled';
    if (
      !repeatOwnRequest &&
      (session?.status !== 'active' ||
        resolveMetadataSessionSpace(session, policy) !== task.spaceId)
    )
      return denied;
  }
  return { value: target };
}

export function createCancelTaskOperation(
  getDatabase: () => Database,
  jobQueue: JobQueueRepository,
  policy: CancelPolicyContext
) {
  const cancel = (superpipe({ getDatabase, jobQueue, policy })('cancel-direct-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitManagedCancellation, ['db', 'input', 'caller', 'policy'], 'result:outcome')
    .pipe(admitCancellation, ['db', 'input', 'caller', 'policy'], 'result:outcome')
    .pipe(enqueueDirectOutcome, ['db', 'jobQueue', 'outcome'], 'outcome')
    .endAsync('outcome') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<DirectOutcomeAcknowledgement>;
  return defineOperation({
    name: 'task.cancel',
    description:
      'Persist cancellation of one running task, direct-execution or Space-owned, and return its acknowledgement. RPC/internal callers and active persisted MCP sessions in the owning Space use the same operation. Never cascades to dependent tasks: it cancels exactly the named task. The direct-execution binding (a task with no direct-execution attempt is out of scope for it) returns a durable job acknowledgement ({ accepted: true, jobId }) that a worker later fulfills. The managed binding covers every Space-owned task without a direct-execution attempt: workflow-owned tasks run the same stopWorkflowBackedTaskForStatus stop path as spaceTask.update — validating the transition, setting status, and tearing down the task-owning workflow agents — while plain tasks (no workflow run) get a direct status write through the Space task manager; both complete synchronously with jobId: null. Rejects direct_cancellation_unavailable/direct_cancellation_denied for the direct binding, and cancellation_unavailable/cancellation_denied for the managed binding, on the same unsupported-state-vs-out-of-scope-caller split (unavailable: retry after state changes, including when the required binding is not configured; denied: do not retry); an invalid-transition rejection from the managed path itself returns cancellation_invalid_transition; any other failure (an infrastructure fault, not a domain rejection) throws through as execution_failed. Acceptance does not mean shutdown has completed.',
    inputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), jobId: z.string().nullable() }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    execute: async (input, caller) => cancel(input, caller),
  });
}
