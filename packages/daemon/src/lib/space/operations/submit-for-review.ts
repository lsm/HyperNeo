import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import { requireDirectTaskWorkerIdentity } from '../runtime/direct-task-worker-identity.ts';
import {
  resolveMetadataSessionSpace,
  type SpaceTaskMetadataDependencies,
} from './task-metadata.ts';
import { Logger } from '../../logger.ts';
import {
  readDirectFinalizationRequest,
  type DirectFinalizationInput,
} from '../runtime/finalize-direct-attempt.ts';
import {
  enqueueDirectOutcome,
  type DirectOutcomeAcknowledgement,
} from '../runtime/direct-outcome-jobs.ts';

const log = new Logger('SubmitForReview');
const inputSchema = z
  .object({ taskId: z.string().min(1), reason: z.string().nullable().optional() })
  .strict();
type Input = z.infer<typeof inputSchema>;
type SubmitForReviewTaskDependencies = Pick<
  SpaceTaskMetadataDependencies,
  'getTaskManager' | 'emitTaskUpdated'
> &
  SpaceMcpSessionPolicyContext;

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

async function admitManagedSubmission(
  db: Database,
  input: Input,
  caller: OperationCaller,
  tasks: SubmitForReviewTaskDependencies
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
  try {
    const updated = await tasks.getTaskManager(task.spaceId).submitTaskForReview(task.id, {
      submittedByNodeId: null,
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

function admitSubmission(
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

export function createSubmitTaskForReviewOperation(
  getDatabase: () => Database,
  jobQueue: JobQueueRepository,
  tasks: SubmitForReviewTaskDependencies
) {
  const submit = (
    superpipe({ getDatabase, jobQueue, tasks })('submit-task-for-review') as PipelineAPI
  )
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitManagedSubmission, ['db', 'input', 'caller', 'tasks'], 'result:outcome')
    .pipe(admitSubmission, ['db', 'input', 'caller'], 'result:outcome')
    .pipe(enqueueDirectOutcome, ['db', 'jobQueue', 'outcome'], 'outcome')
    .endAsync('outcome') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<DirectOutcomeAcknowledgement>;
  return defineOperation({
    name: 'task.submitForReview',
    description:
      'Persist a completion-review request for a direct-execution or Space-owned task and return its acknowledgement. RPC/internal callers and admitted MCP sessions on either ownership mode use the same operation. Direct-execution tasks (a persisted taskAgentSessionId) return a durable job acknowledgement; rejects direct_review_submission_unavailable when the task or its direct-execution state does not support this binding (no active direct attempt — retry after state changes), and direct_review_submission_denied when the calling MCP session is not the attempt’s own persisted worker (do not retry). Every other Space-owned task — workflow-owned or plain (manually tracked) — is admitted through the same manager-backed binding and completes synchronously with jobId: null; rejects review_submission_unavailable when the task is missing or archived (retry after state changes), review_submission_denied when the calling MCP session is not active in the owning Space (do not retry), and review_submission_invalid_transition when the task’s current status or checkpoint state does not allow review submission (retry after state changes). Any other manager failure (an infrastructure fault, not a domain rejection) throws through as execution_failed rather than being reported as accepted: false. Acceptance does not mean shutdown or review finalization has completed.',
    inputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), jobId: z.string().nullable() }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    execute: async (input, caller) => submit(input, caller),
  });
}
