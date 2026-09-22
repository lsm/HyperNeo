import type { Database } from '../../storage/sqlite-compat.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { SessionRepository } from '../../storage/repositories/session-repository.ts';
import { DirectTaskExecutionRepository } from '../../storage/repositories/direct-task-execution-repository.ts';
import { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { OperationCaller } from '../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';
import { requireDirectTaskWorkerIdentity } from './direct-task-worker-identity.ts';
import { resolveMetadataSessionSpace, type SpaceTaskMetadataDependencies } from './metadata.ts';
import type { SpaceTaskManager } from './task-manager.ts';
import { Logger } from '../logger.ts';
import {
  readDirectFinalizationRequest,
  type DirectFinalizationInput,
} from './finalize-direct-attempt.ts';
import type { DirectOutcomeAcknowledgement } from './direct-outcome-jobs.ts';

const log = new Logger('SubmitForReview');
type Input = { taskId: string; reason?: string | null };
export type ReviewSubmissionDependencies = Pick<SpaceTaskMetadataDependencies, 'emitTaskUpdated'> &
  SpaceMcpSessionPolicyContext & {
    getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'submitTaskForReview'>;
  };

const WORKFLOW_SUBMISSION_REJECTIONS: [substring: string, reason: string][] = [
  ['Task not found:', 'review_submission_unavailable'],
  ["Cannot re-submit task in 'review'", 'review_submission_invalid_transition'],
  ['Invalid status transition from', 'review_submission_invalid_transition'],
  [
    'cannot be submitted for review while its direct start is queued',
    'review_submission_invalid_transition',
  ],
];

function resolveWorkflowSubmissionRejection(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : '';
  return WORKFLOW_SUBMISSION_REJECTIONS.find(([substring]) => message.includes(substring))?.[1];
}

function reviewBackedByFrozenDirectRequest(db: Database, taskId: string, sessionId: string) {
  const row = db
    .prepare('SELECT id FROM direct_task_execution_attempts WHERE task_id = ? AND session_id = ?')
    .get(taskId, sessionId) as { id: string } | null;
  if (!row) return false;
  return readDirectFinalizationRequest(db, { attemptId: row.id, sessionId })?.status === 'review';
}

export async function admitManagedSubmission(
  db: Database,
  input: Input,
  caller: OperationCaller,
  tasks: ReviewSubmissionDependencies
): Promise<{ value: true } | { reason: DirectOutcomeAcknowledgement }> {
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  const hasActiveDirectAttempt =
    task?.taskAgentSessionId &&
    (!!new DirectTaskExecutionRepository(db).getActive(task.id) ||
      (task.status === 'review' &&
        reviewBackedByFrozenDirectRequest(db, task.id, task.taskAgentSessionId)));
  if (!task?.spaceId || hasActiveDirectAttempt) return { value: true };
  if (task.archivedAt)
    return { reason: { accepted: false, reason: 'review_submission_unavailable' } };
  if (caller.source === 'mcp') {
    const session = caller.sessionId
      ? new SessionRepository(db).getSession(caller.sessionId)
      : null;
    if (
      session?.status !== 'active' ||
      resolveMetadataSessionSpace(session, tasks) !== task.spaceId
    )
      return { reason: { accepted: false, reason: 'review_submission_denied' } };
  }
  if (!task.workflowRunId && new DirectTaskExecutionRepository(db).getActive(task.id))
    return { reason: { accepted: false, reason: 'review_submission_unavailable' } };
  const callerExecution =
    caller.source === 'mcp' && caller.sessionId
      ? new NodeExecutionRepository(db).getByAgentSessionId(caller.sessionId)
      : null;
  const submittedByNodeId =
    callerExecution && callerExecution.workflowRunId === task.workflowRunId
      ? callerExecution.workflowNodeId
      : null;
  try {
    const updated = await tasks.getTaskManager(task.spaceId).submitTaskForReview(task.id, {
      submittedByNodeId,
      reason: input.reason ?? null,
    });
    await tasks.emitTaskUpdated(task.spaceId, updated).catch((error: unknown) => {
      log.warn('Failed to emit space.task.updated:', error);
    });
    return { reason: { accepted: true, jobId: null } };
  } catch (error) {
    const reason = resolveWorkflowSubmissionRejection(error);
    if (!reason) throw error;
    return { reason: { accepted: false, reason } };
  }
}

export function admitSubmission(
  db: Database,
  input: Input,
  caller: OperationCaller
): { value: DirectFinalizationInput } | { reason: DirectOutcomeAcknowledgement } {
  const unavailable = {
    reason: { accepted: false as const, reason: 'direct_review_submission_unavailable' },
  };
  const denied = {
    reason: { accepted: false as const, reason: 'direct_review_submission_denied' },
  };
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  if (!task || task.workflowRunId || !task.taskAgentSessionId || task.archivedAt)
    return unavailable;
  const attempts = new DirectTaskExecutionRepository(db);
  const row = db
    .prepare('SELECT id FROM direct_task_execution_attempts WHERE task_id = ? AND session_id = ?')
    .get(task.id, task.taskAgentSessionId) as { id: string } | null;
  const attempt = row ? attempts.get(row.id) : null;
  if (!attempt) return unavailable;
  const target: DirectFinalizationInput = {
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    generation: attempt.generation,
    status: 'review',
    reviewReason: input.reason ?? null,
  };
  if (caller.source === 'mcp') {
    if (caller.sessionId !== attempt.sessionId) return denied;
    const session = new SessionRepository(db).getSession(caller.sessionId);
    if (
      !session ||
      session.type !== 'worker' ||
      session.context?.taskId !== task.id ||
      session.context?.spaceId !== task.spaceId
    )
      return denied;
    const frozen = readDirectFinalizationRequest(db, target);
    const sameRequest = frozen?.status === 'review' && frozen.reviewReason === target.reviewReason;
    if (
      !sameRequest &&
      ('reason' in
        requireDirectTaskWorkerIdentity(caller.sessionId, {
          session,
          task,
          attempt: attempts.getActive(task.id),
        }) ||
        attempt.phase !== 'running')
    )
      return denied;
  }
  return { value: target };
}
