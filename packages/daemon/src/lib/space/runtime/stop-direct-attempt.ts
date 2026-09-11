import type { AgentSession } from '../../agent/agent-session.ts';
import type { SessionManager } from '../../session/session-manager.ts';
import type {
  DirectTaskAttempt,
  DirectTaskExecutionRepository,
} from '../../../storage/repositories/direct-task-execution-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { requireDirectTaskWorkerIdentity } from './direct-task-worker-identity.ts';
import { inspectSessionLiveness } from './stop-verification-gates.ts';

export interface DirectAttemptStopInput {
  attemptId: string;
  sessionId: string;
  outcome: string;
}
export type DirectAttemptStopResult =
  | { stopped: true; attempt: DirectTaskAttempt }
  | { stopped: false; reason: 'unavailable' | 'unverified' };
export interface DirectAttemptStopDependencies {
  attempts: Pick<
    DirectTaskExecutionRepository,
    | 'get'
    | 'getActive'
    | 'requestStop'
    | 'finishRequestedStop'
    | 'isStopRequested'
    | 'recordStopVerification'
    | 'hasStopVerification'
    | 'clearStopVerification'
  >;
  tasks: Pick<SpaceTaskRepository, 'getTask'>;
  sessionManager: Pick<
    SessionManager,
    'getCachedSession' | 'isSessionLoading' | 'unregisterSession'
  >;
}

export function requireDirectStopTarget(
  attempt: DirectTaskAttempt | null,
  input: DirectAttemptStopInput
): { value: DirectTaskAttempt } | { reason: DirectAttemptStopResult } {
  if (!attempt || attempt.sessionId !== input.sessionId)
    return { reason: { stopped: false, reason: 'unavailable' } };
  return attempt.phase === 'stopped' ? { reason: { stopped: true, attempt } } : { value: attempt };
}

function claimStop(
  attempts: DirectAttemptStopDependencies['attempts'],
  input: DirectAttemptStopInput
) {
  const target = requireDirectStopTarget(attempts.get(input.attemptId), input);
  if ('reason' in target) return target;
  return requireDirectStopTarget(
    attempts.requestStop(input.attemptId, input.sessionId, input.outcome),
    input
  );
}

export function directSessionIsDown(session: AgentSession): boolean {
  return inspectSessionLiveness({
    processingStatus: session.getProcessingState().status,
    interruptInProgress: session.isInterruptInProgress(),
    livePids: session.getTrackedAgentRootPidsSplit().live,
  }).down;
}

export interface VerifiedDirectStop {
  attempt: DirectTaskAttempt;
  session: AgentSession | null;
}

export async function verifyDirectAttemptStop(
  attempts: DirectAttemptStopDependencies['attempts'],
  tasks: DirectAttemptStopDependencies['tasks'],
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  attempt: DirectTaskAttempt
): Promise<{ value: VerifiedDirectStop } | { reason: DirectAttemptStopResult }> {
  const current = attempts.get(attempt.id);
  if (
    !current ||
    current.sessionId !== attempt.sessionId ||
    current.generation !== attempt.generation ||
    current.phase === 'stopped' ||
    !attempts.isStopRequested(current.id, current.sessionId)
  )
    return { reason: { stopped: false, reason: 'unavailable' } };
  attempt = current;
  if (sessionManager.isSessionLoading(attempt.sessionId)) {
    attempts.clearStopVerification(attempt.id, attempt.sessionId);
    return { reason: { stopped: false, reason: 'unverified' } };
  }
  const session = sessionManager.getCachedSession(attempt.sessionId);
  if (
    !session &&
    attempt.phase === 'running' &&
    !attempts.hasStopVerification(attempt.id, attempt.sessionId, attempt.generation)
  )
    return { reason: { stopped: false, reason: 'unverified' } };
  if (session) {
    attempts.clearStopVerification(attempt.id, attempt.sessionId);
    const identity = requireDirectTaskWorkerIdentity(attempt.sessionId, {
      session: session.getSessionData(),
      task: tasks.getTask(attempt.taskId),
      attempt: attempts.getActive(attempt.taskId),
    });
    if ('reason' in identity || identity.value.attemptId !== attempt.id)
      return { reason: { stopped: false, reason: 'unverified' } };
    try {
      try {
        await session.handleInterrupt({ skipDeferredReplay: true });
      } finally {
        await session.cleanup();
      }
      if (!directSessionIsDown(session))
        return { reason: { stopped: false, reason: 'unverified' } };
      if (!attempts.recordStopVerification(attempt.id, attempt.sessionId, attempt.generation))
        return { reason: { stopped: false, reason: 'unavailable' } };
      await sessionManager.unregisterSession(attempt.sessionId, session);
    } catch {
      return { reason: { stopped: false, reason: 'unverified' } };
    }
    if (
      !directSessionIsDown(session) ||
      sessionManager.isSessionLoading(attempt.sessionId) ||
      sessionManager.getCachedSession(attempt.sessionId)
    )
      return { reason: { stopped: false, reason: 'unverified' } };
  }
  return { value: { attempt, session } };
}

function finishVerifiedDirectStop(
  attempts: DirectAttemptStopDependencies['attempts'],
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  { attempt, session }: VerifiedDirectStop
): DirectAttemptStopResult {
  if (
    sessionManager.isSessionLoading(attempt.sessionId) ||
    sessionManager.getCachedSession(attempt.sessionId) ||
    (session && !directSessionIsDown(session))
  ) {
    attempts.clearStopVerification(attempt.id, attempt.sessionId);
    return { stopped: false, reason: 'unverified' };
  }
  const stopped = attempts.finishRequestedStop(attempt.id, attempt.sessionId);
  return stopped ? { stopped: true, attempt: stopped } : { stopped: false, reason: 'unavailable' };
}

export function createDirectAttemptStopper(dependencies: DirectAttemptStopDependencies) {
  return (superpipe({ ...dependencies })('stop-direct-task-attempt') as PipelineAPI)
    .input('input')
    .pipe(claimStop, ['attempts', 'input'], 'result:outcome')
    .pipe((attempt: DirectTaskAttempt) => attempt, 'outcome', 'attempt')
    .pipe(
      verifyDirectAttemptStop,
      ['attempts', 'tasks', 'sessionManager', 'attempt'],
      'result:outcome'
    )
    .pipe(finishVerifiedDirectStop, ['attempts', 'sessionManager', 'outcome'], 'outcome')
    .endAsync('outcome') as (input: DirectAttemptStopInput) => Promise<DirectAttemptStopResult>;
}
