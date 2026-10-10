import type { Session, SpaceTask, SpaceTaskStatus } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { SessionRepository } from '../../storage/repositories/session-repository.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../storage/repositories/direct-task-execution-repository.ts';
import { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { NodeExecution } from '@hyperneo/shared';
import type { OperationCaller } from '../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';
import { requireDirectTaskWorkerIdentity } from './direct-task-worker-identity.ts';
import { isActiveSessionInSpace, type SpaceTaskMetadataDependencies } from './metadata.ts';
import type { SpaceTaskManager } from './task-manager.ts';
import { taskRejectionKind, type TaskRejectionKind } from './transitions.ts';
import { Logger } from '../logger.ts';
import {
  readDirectFinalizationRequest,
  type DirectFinalizationInput,
} from './finalize-direct-attempt.ts';
import type { DirectOutcomeAcknowledgement } from './direct-outcome-jobs.ts';

const log = new Logger('SubmitForReview');
type Input = { taskId: string; reason?: string | null; expectedStatus?: SpaceTaskStatus };
export type ReviewSubmissionDependencies = Pick<SpaceTaskMetadataDependencies, 'emitTaskUpdated'> &
  SpaceMcpSessionPolicyContext & {
    getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'submitTaskForReview'>;
  };

const SUBMISSION_REJECTIONS: Partial<Record<TaskRejectionKind, string>> = {
  task_not_found: 'review_submission_unavailable',
  checkpoint_not_refreshable: 'review_submission_invalid_transition',
  invalid_transition: 'review_submission_invalid_transition',
  direct_start_queued: 'review_submission_invalid_transition',
};

function resolveWorkflowSubmissionRejection(error: unknown): string | undefined {
  const kind = taskRejectionKind(error);
  return kind && SUBMISSION_REJECTIONS[kind];
}

type Ack = DirectOutcomeAcknowledgement;
const reject = (reason: string): { reason: Ack } => ({ reason: { accepted: false, reason } });

interface SubmissionEvidence {
  task: SpaceTask | null;
  hasActiveAttempt: boolean;
  frozenReview: boolean;
  callerSession: Session | null;
  callerExecution: NodeExecution | null;
}

function readSubmissionEvidence(
  db: Database,
  input: Input,
  caller: OperationCaller
): SubmissionEvidence {
  const task = new SpaceTaskRepository(db).getTask(input.taskId);
  const attempts = new DirectTaskExecutionRepository(db);
  const frozenAttempt =
    task?.status === 'review' && task.taskAgentSessionId
      ? attempts.getByTaskAndSession(task.id, task.taskAgentSessionId)
      : null;
  const mcpSessionId = caller.source === 'mcp' ? caller.sessionId : undefined;
  return {
    task,
    hasActiveAttempt: !!task && !!attempts.getActive(task.id),
    frozenReview:
      !!frozenAttempt &&
      readDirectFinalizationRequest(db, {
        attemptId: frozenAttempt.id,
        sessionId: frozenAttempt.sessionId,
      })?.status === 'review',
    callerSession: mcpSessionId ? new SessionRepository(db).getSession(mcpSessionId) : null,
    callerExecution: mcpSessionId
      ? new NodeExecutionRepository(db).getByAgentSessionId(mcpSessionId)
      : null,
  };
}

export function requireManagedSubmission(
  evidence: SubmissionEvidence
): { value: SpaceTask } | { reason: Ack | null } {
  const { task } = evidence;
  const directOwned =
    !!task?.taskAgentSessionId && (evidence.hasActiveAttempt || evidence.frozenReview);
  if (!task?.spaceId || directOwned) return { reason: null };
  return task.archivedAt ? reject('review_submission_unavailable') : { value: task };
}

export function requireSubmitterInSpace(
  task: SpaceTask,
  evidence: SubmissionEvidence,
  caller: OperationCaller,
  policy: SpaceMcpSessionPolicyContext
): { value: SpaceTask } | { reason: Ack } {
  if (caller.source !== 'mcp') return { value: task };
  const session = evidence.callerSession;
  return isActiveSessionInSpace(session, task.spaceId, policy)
    ? { value: task }
    : reject('review_submission_denied');
}

export function requireNoUnownedAttempt(
  task: SpaceTask,
  evidence: SubmissionEvidence
): { value: SpaceTask } | { reason: Ack } {
  return !task.workflowRunId && evidence.hasActiveAttempt
    ? reject('review_submission_unavailable')
    : { value: task };
}

export function submittingNodeId(task: SpaceTask, evidence: SubmissionEvidence): string | null {
  const execution = evidence.callerExecution;
  return execution && execution.workflowRunId === task.workflowRunId
    ? execution.workflowNodeId
    : null;
}

async function writeManagedSubmission(
  task: SpaceTask,
  evidence: SubmissionEvidence,
  input: Input,
  tasks: ReviewSubmissionDependencies
): Promise<Ack> {
  try {
    const updated = await tasks.getTaskManager(task.spaceId).submitTaskForReview(task.id, {
      submittedByNodeId: submittingNodeId(task, evidence),
      reason: input.reason ?? null,
      expectedStatus: input.expectedStatus,
    });
    await tasks.emitTaskUpdated(task.spaceId, updated).catch((error: unknown) => {
      log.warn('Failed to emit space.task.updated:', error);
    });
    return { accepted: true, jobId: null };
  } catch (error) {
    const reason = resolveWorkflowSubmissionRejection(error);
    if (!reason) throw error;
    return { accepted: false, reason };
  }
}

const runManagedSubmission = (superpipe({})('submit-managed-space-task') as PipelineAPI)
  .input(['db', 'input', 'caller', 'tasks'])
  .pipe(readSubmissionEvidence, ['db', 'input', 'caller'], 'evidence')
  .pipe(requireManagedSubmission, 'evidence', 'result:ack')
  .pipe(requireSubmitterInSpace, ['ack', 'evidence', 'caller', 'tasks'], 'result:ack')
  .pipe(requireNoUnownedAttempt, ['ack', 'evidence'], 'result:ack')
  .pipe((task: SpaceTask) => task, 'ack', 'task')
  .pipe(writeManagedSubmission, ['task', 'evidence', 'input', 'tasks'], 'ack')
  .endAsync('ack') as (
  db: Database,
  input: Input,
  caller: OperationCaller,
  tasks: ReviewSubmissionDependencies
) => Promise<Ack | null>;

export async function admitManagedSubmission(
  db: Database,
  input: Input,
  caller: OperationCaller,
  tasks: ReviewSubmissionDependencies
): Promise<{ value: true } | { reason: Ack }> {
  const ack = await runManagedSubmission(db, input, caller, tasks);
  return ack ? { reason: ack } : { value: true };
}

type DirectReviewTask = SpaceTask & { taskAgentSessionId: string };

export function requireDirectReviewTask(
  task: SpaceTask | null,
  input: Input
): { value: DirectReviewTask } | { reason: Ack } {
  if (!task || task.workflowRunId || !task.taskAgentSessionId || task.archivedAt)
    return reject('direct_review_submission_unavailable');
  return input.expectedStatus !== undefined && task.status !== input.expectedStatus
    ? reject('invalid_transition')
    : { value: task as DirectReviewTask };
}

interface DirectReviewEvidence {
  attempt: DirectTaskAttempt | null;
  active: DirectTaskAttempt | null;
  session: Session | null;
  frozen: ReturnType<typeof readDirectFinalizationRequest>;
}

function readDirectReviewEvidence(
  db: Database,
  task: DirectReviewTask,
  input: Input,
  caller: OperationCaller
): DirectReviewEvidence {
  const attempts = new DirectTaskExecutionRepository(db);
  const attempt = attempts.getByTaskAndSession(task.id, task.taskAgentSessionId);
  const mcp = caller.source === 'mcp' && caller.sessionId === attempt?.sessionId;
  return {
    attempt,
    active: mcp ? attempts.getActive(task.id) : null,
    session:
      mcp && caller.sessionId ? new SessionRepository(db).getSession(caller.sessionId) : null,
    frozen:
      mcp && attempt
        ? readDirectFinalizationRequest(db, { attemptId: attempt.id, sessionId: attempt.sessionId })
        : null,
  };
}

export function requireDirectReviewSubmitter(
  task: DirectReviewTask,
  evidence: DirectReviewEvidence,
  input: Input,
  caller: OperationCaller
): { value: DirectFinalizationInput } | { reason: Ack } {
  const { attempt, session } = evidence;
  if (!attempt) return reject('direct_review_submission_unavailable');
  const target: DirectFinalizationInput = {
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    generation: attempt.generation,
    status: 'review',
    reviewReason: input.reason ?? null,
  };
  if (caller.source !== 'mcp') return { value: target };
  const denied = reject('direct_review_submission_denied');
  if (caller.sessionId !== attempt.sessionId || !caller.sessionId) return denied;
  if (
    !session ||
    session.type !== 'worker' ||
    session.context?.taskId !== task.id ||
    session.context?.spaceId !== task.spaceId
  )
    return denied;
  const sameRequest =
    evidence.frozen?.status === 'review' && evidence.frozen.reviewReason === target.reviewReason;
  if (
    !sameRequest &&
    ('reason' in
      requireDirectTaskWorkerIdentity(caller.sessionId, {
        session,
        task,
        attempt: evidence.active,
      }) ||
      attempt.phase !== 'running')
  )
    return denied;
  return { value: target };
}

const runDirectSubmission = (superpipe({})('submit-direct-space-task') as PipelineAPI)
  .input(['db', 'input', 'caller'])
  .pipe(
    (db: Database, input: Input) => new SpaceTaskRepository(db).getTask(input.taskId),
    ['db', 'input'],
    'loaded'
  )
  .pipe(requireDirectReviewTask, ['loaded', 'input'], 'result:target')
  .pipe((task: DirectReviewTask) => task, 'target', 'task')
  .pipe(readDirectReviewEvidence, ['db', 'task', 'input', 'caller'], 'evidence')
  .pipe(requireDirectReviewSubmitter, ['task', 'evidence', 'input', 'caller'], 'result:target')
  .end('target') as (
  db: Database,
  input: Input,
  caller: OperationCaller
) => DirectFinalizationInput | Ack;

export function admitSubmission(
  db: Database,
  input: Input,
  caller: OperationCaller
): { value: DirectFinalizationInput } | { reason: Ack } {
  const target = runDirectSubmission(db, input, caller);
  return 'accepted' in target ? { reason: target } : { value: target };
}
