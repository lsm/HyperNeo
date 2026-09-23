import type { SpaceTask } from '@hyperneo/shared';
import type { Database } from '../../storage/sqlite-compat.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { SessionRepository } from '../../storage/repositories/session-repository.ts';
import { DirectTaskExecutionRepository } from '../../storage/repositories/direct-task-execution-repository.ts';
import type { OperationCaller } from '../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';
import { StaleTaskGuardError, type SpaceTaskManager } from './task-manager.ts';
import { resolveMetadataSessionSpace } from './metadata.ts';
import { resolveCancellationRoute, supersedeReservedAttempt } from './cancel-route.ts';
import type { SpaceTaskDependencyDependencies } from './dependencies.ts';
import { Logger } from '../logger.ts';
import {
  readDirectFinalizationRequest,
  type DirectFinalizationInput,
} from './finalize-direct-attempt.ts';
import type { DirectOutcomeAcknowledgement } from './direct-outcome-jobs.ts';
import { stopTaskExecution, type TaskStoppingExecutor } from './stop-task-execution.ts';

const log = new Logger('CancelTask');
type Input = { taskId: string };
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

export async function admitManagedCancellation(
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: CancelPolicyContext
): Promise<{ value: undefined } | { reason: DirectOutcomeAcknowledgement }> {
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  if (!task?.spaceId) return { value: undefined };
  const route = resolveCancellationRoute(db, task);
  if (route.kind === 'direct') return { value: undefined };
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
  if (route.kind === 'workflow') {
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
      if (error instanceof StaleTaskGuardError) {
        return { reason: { accepted: false, reason: 'cancellation_unavailable' } };
      }
      if (!resolveWorkflowCancellationRejection(error)) throw error;
      return { reason: { accepted: false, reason: 'cancellation_invalid_transition' } };
    }
  }
  const getTaskManager = policy.getTaskManager;
  if (!getTaskManager) return { reason: { accepted: false, reason: 'cancellation_unavailable' } };
  const guardWrite = (current: SpaceTask): string | undefined => {
    if (current.archivedAt || current.status === 'cancelled' || current.status === 'done')
      return 'already_terminal';
    if (route.kind === 'reserved')
      return supersedeReservedAttempt(db, route.attempt) ? undefined : 'reserved_attempt_race';
    return new DirectTaskExecutionRepository(db).getActive(current.id)
      ? 'attempt_claimed_after_route'
      : undefined;
  };
  try {
    const updated = await getTaskManager(task.spaceId).setTaskStatus(task.id, 'cancelled', {
      guardWrite,
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
    if (error instanceof StaleTaskGuardError) {
      return { reason: { accepted: false, reason: 'cancellation_unavailable' } };
    }
    if (!resolveWorkflowCancellationRejection(error)) throw error;
    return { reason: { accepted: false, reason: 'cancellation_invalid_transition' } };
  }
}

export function admitCancellation(
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
