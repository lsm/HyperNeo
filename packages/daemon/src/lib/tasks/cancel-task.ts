import type { Session, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { SessionRepository } from '../../storage/repositories/session-repository.ts';
import { DirectTaskExecutionRepository } from '../../storage/repositories/direct-task-execution-repository.ts';
import type { OperationCaller } from '../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';
import { StaleTaskGuardError, type SpaceTaskManager } from './task-manager.ts';
import { taskRejectionKind } from './transitions.ts';
import { isActiveSessionInSpace } from './metadata.ts';
import {
  resolveCancellationRoute,
  supersedeReservedAttempt,
  type CancellationRoute,
} from './cancel-route.ts';
import type { SpaceTaskDependencyDependencies } from './dependencies.ts';
import { Logger } from '../logger.ts';
import {
  readDirectFinalizationRequest,
  type DirectFinalizationInput,
} from './finalize-direct-attempt.ts';
import type { DirectOutcomeAcknowledgement } from './direct-outcome-jobs.ts';
import { stopTaskExecution, type TaskStoppingExecutor } from './stop-task-execution.ts';

const log = new Logger('CancelTask');
type Input = { taskId: string; expectedStatus?: SpaceTask['status'] };
export type CancelPolicyContext = SpaceMcpSessionPolicyContext &
  Pick<SpaceTaskDependencyDependencies, 'stopForStatus'> & {
    getTaskManager?: (spaceId: string) => Pick<SpaceTaskManager, 'setTaskStatus'>;
    emitTaskUpdated?: (spaceId: string, task: SpaceTask) => Promise<void>;
    expediteDirectStart?: (attemptId: string) => void;
  };

type Ack = DirectOutcomeAcknowledgement;
const reject = (reason: string): { reason: Ack } => ({ reason: { accepted: false, reason } });

interface CancelEvidence {
  task: SpaceTask | null;
  callerSession: Session | null;
}

function readCancelEvidence(db: Database, input: Input, caller: OperationCaller): CancelEvidence {
  return {
    task: new SpaceTaskRepository(db).getTask(input.taskId),
    callerSession:
      caller.source === 'mcp' && caller.sessionId
        ? new SessionRepository(db).getSession(caller.sessionId)
        : null,
  };
}

function finishedForCaller(status: SpaceTask['status'], caller: OperationCaller): boolean {
  return status === 'cancelled' || (status === 'done' && caller.source !== 'rpc');
}

export function requireExpectedCancelStatus(
  task: SpaceTask,
  input: Input
): { value: SpaceTask } | { reason: Ack } {
  return input.expectedStatus !== undefined && task.status !== input.expectedStatus
    ? reject('invalid_transition')
    : { value: task };
}

function readManagedRoute(db: Database, evidence: CancelEvidence): CancellationRoute | null {
  return evidence.task?.spaceId ? resolveCancellationRoute(db, evidence.task) : null;
}

export function requireManagedCancellation(
  evidence: CancelEvidence,
  route: CancellationRoute | null,
  caller: OperationCaller
): { value: SpaceTask } | { reason: Ack | null } {
  const { task } = evidence;
  if (!task || !route || route.kind === 'direct') return { reason: null };
  return task.archivedAt || finishedForCaller(task.status, caller)
    ? reject('cancellation_unavailable')
    : { value: task };
}

export function requireCancellerInSpace(
  task: SpaceTask,
  evidence: CancelEvidence,
  caller: OperationCaller,
  policy: SpaceMcpSessionPolicyContext,
  denial: string
): { value: SpaceTask } | { reason: Ack } {
  if (caller.source !== 'mcp') return { value: task };
  const session = evidence.callerSession;
  return isActiveSessionInSpace(session, task.spaceId, policy) ? { value: task } : reject(denial);
}

function mapCancellationFailure(error: unknown): Ack {
  if (error instanceof StaleTaskGuardError)
    return { accepted: false, reason: 'cancellation_unavailable' };
  if (taskRejectionKind(error) !== 'invalid_transition') throw error;
  return { accepted: false, reason: 'cancellation_invalid_transition' };
}

async function stopWorkflowForCancellation(
  task: SpaceTask,
  policy: CancelPolicyContext
): Promise<Ack> {
  const stopForStatus = policy.stopForStatus;
  if (!stopForStatus) return { accepted: false, reason: 'cancellation_unavailable' };
  const executor: TaskStoppingExecutor<SpaceTask> = {
    stopForStatus: (taskId, targetStatus) =>
      stopForStatus(task.spaceId, taskId, { status: targetStatus }),
  };
  try {
    await stopTaskExecution(executor, task.id, 'cancelled');
    return { accepted: true, jobId: null };
  } catch (error) {
    return mapCancellationFailure(error);
  }
}

function emitCancelled(policy: CancelPolicyContext, spaceId: string, task: SpaceTask) {
  return policy.emitTaskUpdated?.(spaceId, task).catch((error: unknown) => {
    log.warn('Failed to emit space.task.updated:', error);
  });
}

async function writeManagedCancellation(
  db: Database,
  task: SpaceTask,
  route: Exclude<CancellationRoute, { kind: 'workflow' } | { kind: 'direct' }>,
  caller: OperationCaller,
  policy: CancelPolicyContext
): Promise<Ack> {
  const getTaskManager = policy.getTaskManager;
  if (!getTaskManager) return { accepted: false, reason: 'cancellation_unavailable' };
  const guardWrite = (current: SpaceTask): string | undefined => {
    if (current.archivedAt || finishedForCaller(current.status, caller)) return 'already_terminal';
    if (current.status !== task.status) return 'status_changed';
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
        for (const cascadedTask of cascaded)
          await emitCancelled(policy, task.spaceId, cascadedTask);
      },
    });
    await emitCancelled(policy, task.spaceId, updated);
    if (route.kind === 'reserved') policy.expediteDirectStart?.(route.attempt.id);
    return { accepted: true, jobId: null };
  } catch (error) {
    return mapCancellationFailure(error);
  }
}

function executeManagedCancellation(
  db: Database,
  task: SpaceTask,
  route: CancellationRoute,
  caller: OperationCaller,
  policy: CancelPolicyContext
): Promise<Ack> {
  if (route.kind === 'workflow') return stopWorkflowForCancellation(task, policy);
  if (route.kind === 'direct') throw new Error('Direct cancellation is not a managed route');
  return writeManagedCancellation(db, task, route, caller, policy);
}

const runManagedCancellation = (superpipe({})('cancel-managed-space-task') as PipelineAPI)
  .input(['db', 'input', 'caller', 'policy'])
  .pipe(readCancelEvidence, ['db', 'input', 'caller'], 'evidence')
  .pipe(readManagedRoute, ['db', 'evidence'], 'route')
  .pipe(requireManagedCancellation, ['evidence', 'route', 'caller'], 'result:ack')
  .pipe(requireExpectedCancelStatus, ['ack', 'input'], 'result:ack')
  .pipe((task: SpaceTask) => task, 'ack', 'task')
  .pipe(
    (
      task: SpaceTask,
      evidence: CancelEvidence,
      caller: OperationCaller,
      policy: CancelPolicyContext
    ) => requireCancellerInSpace(task, evidence, caller, policy, 'cancellation_denied'),
    ['task', 'evidence', 'caller', 'policy'],
    'result:ack'
  )
  .pipe(executeManagedCancellation, ['db', 'task', 'route', 'caller', 'policy'], 'ack')
  .endAsync('ack') as (
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: CancelPolicyContext
) => Promise<Ack | null>;

export async function admitManagedCancellation(
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: CancelPolicyContext
): Promise<{ value: undefined } | { reason: Ack }> {
  const ack = await runManagedCancellation(db, input, caller, policy);
  return ack ? { reason: ack } : { value: undefined };
}

export function requireDirectCancelTask(
  task: SpaceTask | null
): { value: SpaceTask & { taskAgentSessionId: string } } | { reason: Ack } {
  return !task?.spaceId || task.workflowRunId || !task.taskAgentSessionId || task.archivedAt
    ? reject('direct_cancellation_unavailable')
    : { value: task as SpaceTask & { taskAgentSessionId: string } };
}

function readDirectCancelTarget(db: Database, task: SpaceTask & { taskAgentSessionId: string }) {
  const attempt = new DirectTaskExecutionRepository(db).getByTaskAndSession(
    task.id,
    task.taskAgentSessionId
  );
  if (!attempt) return null;
  const target: DirectFinalizationInput = {
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    generation: attempt.generation,
    status: 'cancelled',
  };
  return { target, frozenStatus: readDirectFinalizationRequest(db, target)?.status ?? null };
}

export function requireDirectCanceller(
  task: SpaceTask,
  found: ReturnType<typeof readDirectCancelTarget>,
  evidence: CancelEvidence,
  caller: OperationCaller,
  policy: SpaceMcpSessionPolicyContext
): { value: DirectFinalizationInput } | { reason: Ack } {
  if (!found) return reject('direct_cancellation_unavailable');
  if (caller.source !== 'mcp') return { value: found.target };
  const session = evidence.callerSession;
  const repeatOwnRequest =
    session?.id === found.target.sessionId &&
    session.type === 'worker' &&
    session.context?.taskId === task.id &&
    session.context.spaceId === task.spaceId &&
    found.frozenStatus === 'cancelled';
  if (repeatOwnRequest) return { value: found.target };
  return isActiveSessionInSpace(session, task.spaceId, policy)
    ? { value: found.target }
    : reject('direct_cancellation_denied');
}

const runDirectCancellation = (superpipe({})('cancel-direct-space-task') as PipelineAPI)
  .input(['db', 'input', 'caller', 'policy'])
  .pipe(readCancelEvidence, ['db', 'input', 'caller'], 'evidence')
  .pipe((evidence: CancelEvidence) => evidence.task, 'evidence', 'loaded')
  .pipe(requireDirectCancelTask, 'loaded', 'result:target')
  .pipe(requireExpectedCancelStatus, ['target', 'input'], 'result:target')
  .pipe((task: SpaceTask & { taskAgentSessionId: string }) => task, 'target', 'task')
  .pipe(readDirectCancelTarget, ['db', 'task'], 'found')
  .pipe(requireDirectCanceller, ['task', 'found', 'evidence', 'caller', 'policy'], 'result:target')
  .end('target') as (
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: SpaceMcpSessionPolicyContext
) => DirectFinalizationInput | Ack;

export function admitCancellation(
  db: Database,
  input: Input,
  caller: OperationCaller,
  policy: SpaceMcpSessionPolicyContext
): { value: DirectFinalizationInput } | { reason: Ack } {
  const target = runDirectCancellation(db, input, caller, policy);
  return 'accepted' in target ? { reason: target } : { value: target };
}
