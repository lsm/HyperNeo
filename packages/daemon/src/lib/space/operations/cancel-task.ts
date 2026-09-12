import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
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
import { stopTaskExecution, type TaskStoppingExecutor } from '../../tasks/stop-task-execution.ts';

const inputSchema = z.object({ taskId: z.string().min(1) }).strict();
type Input = z.infer<typeof inputSchema>;
type BlockExecution = (
  spaceId: string,
  taskId: string,
  params: UpdateSpaceTaskParams
) => Promise<SpaceTask | null>;
type CancelPolicyContext = SpaceMcpSessionPolicyContext & { blockExecution?: BlockExecution };

async function admitWorkflowCancellation(
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: CancelPolicyContext
): Promise<{ value: undefined } | { reason: DirectOutcomeAcknowledgement }> {
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  if (!task?.spaceId || !task.workflowRunId || task.archivedAt) return { value: undefined };
  if (task.status === 'cancelled' || task.status === 'done' || task.status === 'archived')
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
  const blockExecution = policy.blockExecution;
  const executor: TaskStoppingExecutor<SpaceTask> | undefined = blockExecution
    ? {
        stopForStatus: (taskId, targetStatus) =>
          blockExecution(task.spaceId, taskId, { status: targetStatus }),
      }
    : undefined;
  const stopped = await stopTaskExecution(executor, task.id, 'cancelled');
  return typeof stopped === 'string' || stopped === null
    ? { reason: { accepted: false, reason: 'cancellation_invalid_transition' } }
    : { reason: { accepted: true, jobId: null } };
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
    .pipe(admitWorkflowCancellation, ['db', 'input', 'caller', 'policy'], 'result:outcome')
    .pipe(admitCancellation, ['db', 'input', 'caller', 'policy'], 'result:outcome')
    .pipe(enqueueDirectOutcome, ['db', 'jobQueue', 'outcome'], 'outcome')
    .endAsync('outcome') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<DirectOutcomeAcknowledgement>;
  return defineOperation({
    name: 'task.cancel',
    description:
      'Persist cancellation of one running task, direct-execution or workflow-owned, and return its acknowledgement. RPC/internal callers and active persisted MCP sessions in the owning Space use the same operation. Never cascades to dependent tasks: it cancels exactly the named task. The direct-execution binding returns a durable job acknowledgement ({ accepted: true, jobId }) that a worker later fulfills; the workflow binding runs the same stop path as spaceTask.update and completes synchronously with jobId: null. Rejects direct_cancellation_unavailable/direct_cancellation_denied for the direct binding, and cancellation_unavailable/cancellation_denied for the workflow binding, on the same unsupported-state-vs-out-of-scope-caller split (unavailable: retry after state changes; denied: do not retry); a domain rejection from the workflow stop itself (invalid transition, missing run) returns cancellation_invalid_transition. Acceptance does not mean shutdown has completed.',
    inputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), jobId: z.string().nullable() }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    execute: async (input, caller) => cancel(input, caller),
  });
}
