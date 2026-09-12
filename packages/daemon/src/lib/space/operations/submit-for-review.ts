import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { requireDirectTaskWorkerIdentity } from '../runtime/direct-task-worker-identity.ts';
import {
  readDirectFinalizationRequest,
  type DirectFinalizationInput,
} from '../runtime/finalize-direct-attempt.ts';
import {
  enqueueDirectOutcome,
  type DirectOutcomeAcknowledgement,
} from '../runtime/direct-outcome-jobs.ts';

const inputSchema = z
  .object({ taskId: z.string().min(1), reason: z.string().nullable().optional() })
  .strict();
type Input = z.infer<typeof inputSchema>;

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
  jobQueue: JobQueueRepository
) {
  const submit = (superpipe({ getDatabase, jobQueue })('submit-task-for-review') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitSubmission, ['db', 'input', 'caller'], 'result:outcome')
    .pipe(enqueueDirectOutcome, ['db', 'jobQueue', 'outcome'], 'outcome')
    .end('outcome') as (input: Input, caller: OperationCaller) => DirectOutcomeAcknowledgement;
  return defineOperation({
    name: 'task.submitForReview',
    description:
      'Persist a direct task completion-review request and return its durable job acknowledgement. RPC/internal callers and the task’s own persisted direct-worker MCP session use the same operation. Rejects direct_review_submission_unavailable when the task or its direct-execution state does not support this binding (workflow-owned, archived, or no active direct attempt — retry after state changes), and direct_review_submission_denied when the calling MCP session is not the attempt’s own persisted worker (do not retry). Acceptance does not mean shutdown or review finalization has completed.',
    inputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), jobId: z.string().nullable() }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    execute: async (input, caller) => submit(input, caller),
  });
}
