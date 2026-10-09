import { randomUUID } from 'node:crypto';
import type { AgentSession } from '../agent/agent-session.ts';
import type { SessionManager } from '../session/session-manager.ts';
import type {
  DirectTaskAttempt,
  DirectTaskExecutionRepository,
} from '../../storage/repositories/direct-task-execution-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  requireDirectTaskWorkerIdentity,
  type DirectTaskWorkerEvidence,
} from './direct-task-worker-identity.ts';
import {
  decideStopVerification,
  directSessionGone,
  inspectSessionLiveness,
  type DirectSessionGoneEvidence,
  isStopDownProcessingStatus,
} from './stop-verification-gates.ts';

const DIRECT_STOP_EXIT_SETTLE_MS = 500;
const DIRECT_STOP_FORCE_KILL_MS = 2000;

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
    | 'beginStopVerification'
    | 'getStopVerification'
    | 'recordStopVerification'
    | 'hasStopVerification'
    | 'clearStopVerification'
  >;
  tasks: Pick<SpaceTaskRepository, 'getTask'>;
  sessionManager: Pick<
    SessionManager,
    | 'getCachedSession'
    | 'getSessionForControl'
    | 'isSessionLoading'
    | 'unregisterSession'
    | 'coalesceDirectStopVerification'
  >;
}

export function requiresLiveStopProof(
  attempt: Pick<DirectTaskAttempt, 'phase' | 'generation'>,
  recorded: { token: string | null; generation: number | null } | null
): boolean {
  return (
    attempt.phase === 'running' && (recorded?.generation !== attempt.generation || !recorded.token)
  );
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

function readDirectSessionGoneEvidence(
  sessionManager: Pick<SessionManager, 'isSessionLoading' | 'getCachedSession'>,
  { attempt, session }: VerifiedDirectStop
): DirectSessionGoneEvidence | null {
  try {
    return {
      loading: sessionManager.isSessionLoading(attempt.sessionId),
      cached: !!sessionManager.getCachedSession(attempt.sessionId),
      sessionDown: !session || directSessionIsDown(session),
    };
  } catch {
    return null;
  }
}

function clearUnprovenStop(
  attempts: Pick<DirectTaskExecutionRepository, 'clearStopVerification'>,
  { attempt, token }: VerifiedDirectStop,
  gone: boolean
): void {
  if (!gone) attempts.clearStopVerification(attempt.id, attempt.sessionId, token);
}

export const confirmDirectSessionGone = (
  superpipe({})('confirm-direct-session-gone') as PipelineAPI
)
  .input(['attempts', 'sessionManager', 'verified'])
  .pipe(readDirectSessionGoneEvidence, ['sessionManager', 'verified'], 'evidence')
  .pipe(directSessionGone, 'evidence', 'gone')
  .pipe(clearUnprovenStop, ['attempts', 'verified', 'gone'])
  .end('gone') as (
  attempts: Pick<DirectTaskExecutionRepository, 'clearStopVerification'>,
  sessionManager: Pick<SessionManager, 'isSessionLoading' | 'getCachedSession'>,
  verified: VerifiedDirectStop
) => boolean;

async function settleProcessExit(session: AgentSession, timeoutMs: number): Promise<void> {
  if (session.getTrackedAgentRootPidsSplit().live.length === 0) return;
  session.refreshProcessExitedPromise();
  const exited = session.processExitedPromise;
  if (!exited) return;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
  ]);
}

export async function bringDirectSessionDown(session: AgentSession): Promise<boolean> {
  let interrupts = 1;
  let escalated = false;
  for (;;) {
    if (isStopDownProcessingStatus(session.getProcessingState().status))
      await settleProcessExit(session, DIRECT_STOP_EXIT_SETTLE_MS);
    const decision = decideStopVerification({
      sessionPresent: true,
      processingStatus: session.getProcessingState().status,
      interruptInProgress: session.isInterruptInProgress(),
      livePids: session.getTrackedAgentRootPidsSplit().live,
      interruptAttemptsSoFar: interrupts,
      escalationDone: escalated,
    });
    if (decision.action === 'down') return true;
    if (decision.action === 'report_leak') return false;
    if (decision.action === 'retry_interrupt') {
      interrupts += 1;
      await session.handleInterrupt({ skipDeferredReplay: true });
      continue;
    }
    escalated = true;
    session.terminateTrackedAgentProcesses({ forceDelayMs: DIRECT_STOP_FORCE_KILL_MS });
    await settleProcessExit(session, DIRECT_STOP_FORCE_KILL_MS + DIRECT_STOP_EXIT_SETTLE_MS);
  }
}

export interface VerifiedDirectStop {
  attempt: DirectTaskAttempt;
  session: AgentSession | null;
  token: string;
}

export type DirectStopVerificationResult =
  | { value: VerifiedDirectStop }
  | { reason: DirectAttemptStopResult };

type StopProof = { token: string | null; generation: number | null } | null;
type StopVerificationGate =
  | { value: DirectTaskAttempt }
  | { value: VerifiedDirectStop }
  | { reason: DirectAttemptStopResult };
const unavailable = { reason: { stopped: false as const, reason: 'unavailable' as const } };
const unverified = { reason: { stopped: false as const, reason: 'unverified' as const } };

interface StopVerificationState {
  current: DirectTaskAttempt | null;
  stopRequested: boolean;
  recorded: StopProof;
  loading: boolean;
}

function readStopVerificationState(
  attempts: DirectAttemptStopDependencies['attempts'],
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  attempt: DirectTaskAttempt
): StopVerificationState {
  const current = attempts.get(attempt.id);
  return {
    current,
    stopRequested: !!current && attempts.isStopRequested(current.id, current.sessionId),
    recorded: attempts.getStopVerification(attempt.id, attempt.sessionId),
    loading: sessionManager.isSessionLoading(attempt.sessionId),
  };
}

export function classifyStopTarget(
  state: StopVerificationState,
  attempt: Pick<DirectTaskAttempt, 'sessionId' | 'generation'>
): 'unavailable' | 'loading' | 'verifiable' {
  const { current } = state;
  if (
    !current ||
    current.sessionId !== attempt.sessionId ||
    current.generation !== attempt.generation ||
    current.phase === 'stopped' ||
    !state.stopRequested
  )
    return 'unavailable';
  return state.loading ? 'loading' : 'verifiable';
}

function clearProofWhileLoading(
  attempts: DirectAttemptStopDependencies['attempts'],
  target: ReturnType<typeof classifyStopTarget>,
  state: StopVerificationState,
  attempt: DirectTaskAttempt
): void {
  if (target === 'loading' && state.recorded?.token)
    attempts.clearStopVerification(attempt.id, attempt.sessionId, state.recorded.token);
}

export function requireVerifiableStopTarget(
  target: ReturnType<typeof classifyStopTarget>,
  state: StopVerificationState
): StopVerificationGate {
  if (target === 'unavailable' || !state.current) return unavailable;
  return target === 'loading' ? unverified : { value: state.current };
}

async function loadStopSession(
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  current: DirectTaskAttempt,
  state: StopVerificationState
): Promise<{ session: AgentSession | null; needsLiveProof: boolean }> {
  const needsLiveProof = requiresLiveStopProof(current, state.recorded);
  const session =
    sessionManager.getCachedSession(current.sessionId) ??
    (needsLiveProof ? await sessionManager.getSessionForControl(current.sessionId) : null);
  return { session: session ?? null, needsLiveProof };
}

export function requireStopSessionOrProof(
  session: AgentSession | null,
  needsLiveProof: boolean,
  current: DirectTaskAttempt
): StopVerificationGate {
  return !session && needsLiveProof ? unverified : { value: current };
}

function beginStopProof(
  attempts: DirectAttemptStopDependencies['attempts'],
  current: DirectTaskAttempt,
  session: AgentSession | null,
  state: StopVerificationState
): { value: string } | { reason: DirectAttemptStopResult } {
  if (!session && current.phase !== 'reserved')
    return { value: state.recorded?.token ?? randomUUID() };
  const token = randomUUID();
  return attempts.beginStopVerification(current.id, current.sessionId, current.generation, token)
    ? { value: token }
    : unavailable;
}

function readStopIdentityEvidence(
  attempts: DirectAttemptStopDependencies['attempts'],
  tasks: DirectAttemptStopDependencies['tasks'],
  current: DirectTaskAttempt,
  session: AgentSession | null
): DirectTaskWorkerEvidence | null {
  return session
    ? {
        session: session.getSessionData(),
        task: tasks.getTask(current.taskId),
        attempt: attempts.getActive(current.taskId),
      }
    : null;
}

export function requireStopWorkerIdentity(
  evidence: DirectTaskWorkerEvidence | null,
  current: DirectTaskAttempt
): StopVerificationGate {
  if (!evidence) return { value: current };
  const identity = requireDirectTaskWorkerIdentity(current.sessionId, evidence);
  return 'reason' in identity || identity.value.attemptId !== current.id
    ? unverified
    : { value: current };
}

async function proveDirectSessionDown(
  attempts: DirectAttemptStopDependencies['attempts'],
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  current: DirectTaskAttempt,
  session: AgentSession | null,
  token: string
): Promise<StopVerificationGate> {
  const verified = { value: { attempt: current, session, token } };
  if (!session)
    return current.phase === 'reserved' &&
      !attempts.recordStopVerification(current.id, current.sessionId, current.generation, token)
      ? unavailable
      : verified;
  try {
    try {
      await session.handleInterrupt({ skipDeferredReplay: true });
    } finally {
      await session.cleanup();
    }
    if (!(await bringDirectSessionDown(session))) return unverified;
    if (!attempts.recordStopVerification(current.id, current.sessionId, current.generation, token))
      return unavailable;
    await sessionManager.unregisterSession(current.sessionId, session);
    if (!confirmDirectSessionGone(attempts, sessionManager, verified.value)) return unverified;
  } catch {
    attempts.clearStopVerification(current.id, current.sessionId, token);
    return unverified;
  }
  return verified;
}

const runStopVerification = (superpipe({})('verify-direct-attempt-stop') as PipelineAPI)
  .input(['attempts', 'tasks', 'sessionManager', 'attempt'])
  .pipe(readStopVerificationState, ['attempts', 'sessionManager', 'attempt'], 'state')
  .pipe(classifyStopTarget, ['state', 'attempt'], 'target')
  .pipe(clearProofWhileLoading, ['attempts', 'target', 'state', 'attempt'])
  .pipe(requireVerifiableStopTarget, ['target', 'state'], 'result:verification')
  .pipe((current: DirectTaskAttempt) => current, 'verification', 'current')
  .pipe(loadStopSession, ['sessionManager', 'current', 'state'], ['session', 'needsLiveProof'])
  .pipe(requireStopSessionOrProof, ['session', 'needsLiveProof', 'current'], 'result:verification')
  .pipe(beginStopProof, ['attempts', 'current', 'session', 'state'], 'result:verification')
  .pipe((token: string) => token, 'verification', 'token')
  .pipe(readStopIdentityEvidence, ['attempts', 'tasks', 'current', 'session'], 'evidence')
  .pipe(requireStopWorkerIdentity, ['evidence', 'current'], 'result:verification')
  .pipe(
    proveDirectSessionDown,
    ['attempts', 'sessionManager', 'current', 'session', 'token'],
    'result:verification'
  )
  .endAsync('verification') as (
  attempts: DirectAttemptStopDependencies['attempts'],
  tasks: DirectAttemptStopDependencies['tasks'],
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  attempt: DirectTaskAttempt
) => Promise<VerifiedDirectStop | DirectAttemptStopResult>;

async function verifyDirectAttemptStopOwned(
  attempts: DirectAttemptStopDependencies['attempts'],
  tasks: DirectAttemptStopDependencies['tasks'],
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  attempt: DirectTaskAttempt
): Promise<DirectStopVerificationResult> {
  const outcome = await runStopVerification(attempts, tasks, sessionManager, attempt);
  return 'stopped' in outcome ? { reason: outcome } : { value: outcome };
}

export function verifyDirectAttemptStop(
  attempts: DirectAttemptStopDependencies['attempts'],
  tasks: DirectAttemptStopDependencies['tasks'],
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  attempt: DirectTaskAttempt
): Promise<DirectStopVerificationResult> {
  return sessionManager.coalesceDirectStopVerification(
    JSON.stringify([attempt.id, attempt.sessionId, attempt.generation]),
    () => verifyDirectAttemptStopOwned(attempts, tasks, sessionManager, attempt)
  );
}

function finishVerifiedDirectStop(
  attempts: DirectAttemptStopDependencies['attempts'],
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  verified: VerifiedDirectStop
): DirectAttemptStopResult {
  const { attempt, token } = verified;
  if (!confirmDirectSessionGone(attempts, sessionManager, verified))
    return { stopped: false, reason: 'unverified' };
  const stopped = attempts.finishRequestedStop(
    attempt.id,
    attempt.sessionId,
    attempt.generation,
    token
  );
  if (stopped) return { stopped: true, attempt: stopped };
  const completed = attempts.get(attempt.id);
  return completed?.phase === 'stopped' &&
    completed.sessionId === attempt.sessionId &&
    completed.generation === attempt.generation
    ? { stopped: true, attempt: completed }
    : { stopped: false, reason: 'unavailable' };
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
