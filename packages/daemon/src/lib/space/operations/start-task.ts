import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { resolveMetadataSessionSpace } from './task-metadata.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import {
  claimDirectStart,
  directTaskStartIdentity,
  type DirectTaskStartInput,
} from '../runtime/start-direct-task.ts';
import { readDirectStartRequest } from '../runtime/direct-start-request.ts';
import {
  acknowledgeDirectStart,
  type DirectStartAcknowledgement,
} from '../runtime/direct-start-jobs.ts';

const inputSchema = z
  .object({ taskId: z.string().min(1), requestKey: z.string().trim().min(1) })
  .strict();
type Input = z.infer<typeof inputSchema>;
export interface DirectStartOperationDependencies {
  reactiveDb?: ReactiveDatabase;
  onTaskReopened: (taskId: string) => void;
}
function admitStart(
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: SpaceMcpSessionPolicyContext
): { value: DirectTaskStartInput } | { reason: DirectStartAcknowledgement } {
  const unavailable = { reason: { accepted: false as const, reason: 'direct_start_unavailable' } };
  const denied = { reason: { accepted: false as const, reason: 'direct_start_denied' } };
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  if (!task?.spaceId || task.workflowRunId || task.archivedAt) return unavailable;
  if (caller.source === 'mcp') {
    const session = caller.sessionId
      ? new SessionRepository(db).getSession(caller.sessionId)
      : null;
    if (
      session?.status !== 'active' ||
      resolveMetadataSessionSpace(session, policy) !== task.spaceId
    )
      return denied;
  }
  const existing = readDirectStartRequest(db, directTaskStartIdentity(input).attemptId);
  if (existing) return existing.input.reviewRejection ? unavailable : { value: existing.input };
  if (!['blocked', 'cancelled', 'stopped'].includes(task.status)) return { value: input };
  if (!task.taskAgentSessionId) return unavailable;
  const row = db
    .prepare('SELECT id FROM direct_task_execution_attempts WHERE task_id = ? AND session_id = ?')
    .get(task.id, task.taskAgentSessionId) as { id: string } | null;
  const attempt = row ? new DirectTaskExecutionRepository(db).get(row.id) : null;
  return attempt?.phase === 'stopped'
    ? { value: { ...input, retryFrom: { attemptId: attempt.id, generation: attempt.generation } } }
    : unavailable;
}
export function createStartTaskOperation(
  getDatabase: () => Database,
  jobQueue: JobQueueRepository,
  policy: SpaceMcpSessionPolicyContext,
  dependencies: DirectStartOperationDependencies
) {
  const start = (
    superpipe({ getDatabase, jobQueue, policy, ...dependencies })(
      'start-direct-task-operation'
    ) as PipelineAPI
  )
    .input(['input', 'caller'])
    .pipe(getDatabase, undefined, 'db')
    .pipe(admitStart, ['db', 'input', 'caller', 'policy'], 'result:outcome')
    .pipe(claimDirectStart, ['db', 'reactiveDb', 'outcome', 'onTaskReopened', 'jobQueue'], 'claim')
    .pipe(acknowledgeDirectStart, ['db', 'claim'], 'outcome')
    .end('outcome') as (input: Input, caller: OperationCaller) => DirectStartAcknowledgement;
  return defineOperation({
    name: 'task.start',
    description:
      'Persist a direct task start or verified terminal-task retry and return its durable job acknowledgement. Use a stable requestKey for retries of the same request and a new key for a new execution. Rejects direct_start_unavailable when the task or its direct-execution state does not support this binding (workflow-owned, archived, review-rejected, or no verified stopped attempt to retry — retry after state changes), and direct_start_denied when the calling MCP session is not active in the owning Space (do not retry). Acceptance does not mean execution has started.',
    inputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), jobId: z.string().nullable() }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    execute: async (input, caller) => start(input, caller),
  });
}
