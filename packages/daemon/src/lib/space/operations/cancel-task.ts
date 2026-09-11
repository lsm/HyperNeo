import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import { resolveMetadataSessionSpace } from './task-metadata.ts';
import {
  readDirectFinalizationRequest,
  type DirectFinalizationInput,
} from '../runtime/finalize-direct-attempt.ts';
import {
  enqueueDirectOutcome,
  type DirectOutcomeAcknowledgement,
} from '../runtime/direct-outcome-jobs.ts';

const inputSchema = z.object({ taskId: z.string().min(1) }).strict();
type Input = z.infer<typeof inputSchema>;

function admitCancellation(
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: SpaceMcpSessionPolicyContext
): { value: DirectFinalizationInput } | { reason: DirectOutcomeAcknowledgement } {
  const denied = {
    reason: { accepted: false as const, reason: 'direct_cancellation_unavailable' },
  };
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  if (!task?.spaceId || task.workflowRunId || !task.taskAgentSessionId || task.archivedAt)
    return denied;
  const row = db
    .prepare('SELECT id FROM direct_task_execution_attempts WHERE task_id = ? AND session_id = ?')
    .get(task.id, task.taskAgentSessionId) as { id: string } | null;
  const attempt = row ? new DirectTaskExecutionRepository(db).get(row.id) : null;
  if (!attempt) return denied;
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
  policy: SpaceMcpSessionPolicyContext
) {
  const cancel = (superpipe({ getDatabase, jobQueue, policy })('cancel-direct-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitCancellation, ['db', 'input', 'caller', 'policy'], 'result:outcome')
    .pipe(enqueueDirectOutcome, ['db', 'jobQueue', 'outcome'], 'outcome')
    .end('outcome') as (input: Input, caller: OperationCaller) => DirectOutcomeAcknowledgement;
  return defineOperation({
    name: 'task.cancel',
    description:
      'Persist cancellation of one running direct task and return its durable job acknowledgement. RPC/internal callers and active persisted MCP sessions in the owning Space use the same operation. Workflow tasks and dependent-task cascades are not supported by this binding. Acceptance does not mean shutdown has completed.',
    inputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), jobId: z.string().nullable() }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    execute: async (input, caller) => cancel(input, caller),
  });
}
