import type { AgentProcessingState } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { AgentSession } from '../agent/agent-session.ts';
import type { FlowOutcome } from './flow-outcome.ts';
import type { VerifiedSessionStop } from '../space/runtime/task-agent-manager.ts';
import {
  assembleVerifiedStopResult,
  decideStopVerification,
  isStopDownProcessingStatus,
  type SessionLivenessSnapshot,
  type StopVerificationDecision,
} from './stop-verification-gates.ts';

export interface VerifiedStopFlowDeps {
  claimSession(sessionId: string): AgentSession | null;
  stopSessionStrict(sessionId: string, session: AgentSession): Promise<void>;
  readProcessingStatus(session: AgentSession): AgentProcessingState['status'];
  isInterruptInProgress(session: AgentSession): boolean;
  awaitProcessExitSettle(session: AgentSession): Promise<void>;
  readLivePids(session: AgentSession): readonly number[];
  terminateTrackedProcesses(session: AgentSession): void;
  unregisterSession(sessionId: string): Promise<void>;
  detachSessionBookkeeping(sessionId: string): void;
  warn(message: string, err?: unknown): void;
}

export interface VerifiedStopLivenessDeps {
  readProcessingStatus(session: AgentSession): AgentProcessingState['status'];
  isInterruptInProgress(session: AgentSession): boolean;
  awaitProcessExitSettle(session: AgentSession): Promise<void>;
  readLivePids(session: AgentSession): readonly number[];
}

export interface VerifiedStopRequest {
  sessionId: string;
}

export interface VerifiedStopState {
  sessionId: string;
  session: AgentSession | null;
  notes: string[];
  liveness: SessionLivenessSnapshot | null;
  decision: StopVerificationDecision | null;
}

export interface VerifiedStopSettled {
  settled: FlowOutcome;
}

export type VerifiedStopOutcome = VerifiedStopState | VerifiedStopSettled;

export function isVerifiedStopSettled(
  outcome: VerifiedStopOutcome
): outcome is VerifiedStopSettled {
  return 'settled' in outcome;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function retryReasonOf(decision: StopVerificationDecision | null): string {
  return decision?.action === 'retry_interrupt' ? decision.reason : 'still alive';
}

function escalateReasonOf(decision: StopVerificationDecision | null): string {
  return decision?.action === 'escalate_terminate' ? decision.reason : 'still alive';
}

async function gatherSessionLiveness(
  deps: VerifiedStopLivenessDeps,
  session: AgentSession
): Promise<SessionLivenessSnapshot> {
  const processingStatus = deps.readProcessingStatus(session);
  if (!isStopDownProcessingStatus(processingStatus)) {
    return { processingStatus, interruptInProgress: false, livePids: [] };
  }
  const interruptInProgress = deps.isInterruptInProgress(session);
  if (interruptInProgress) {
    return { processingStatus, interruptInProgress, livePids: [] };
  }
  await deps.awaitProcessExitSettle(session);
  return { processingStatus, interruptInProgress, livePids: deps.readLivePids(session) };
}

export type VerifiedStopVerifyStage = (
  readProcessingStatus: VerifiedStopLivenessDeps['readProcessingStatus'],
  isInterruptInProgress: VerifiedStopLivenessDeps['isInterruptInProgress'],
  awaitProcessExitSettle: VerifiedStopLivenessDeps['awaitProcessExitSettle'],
  readLivePids: VerifiedStopLivenessDeps['readLivePids'],
  stop: VerifiedStopState
) => Promise<{ value: VerifiedStopState } | { reason: VerifiedStopSettled }>;

export function makeVerifyStage(stage: string): VerifiedStopVerifyStage {
  return (
    readProcessingStatus,
    isInterruptInProgress,
    awaitProcessExitSettle,
    readLivePids,
    stop
  ) =>
    verifySessionLiveness(
      { readProcessingStatus, isInterruptInProgress, awaitProcessExitSettle, readLivePids },
      stage,
      stop
    );
}

export const verifyAfterInterrupt = makeVerifyStage('verify-after-interrupt');
export const verifyAfterRetry = makeVerifyStage('verify-after-retry');
export const verifyAfterEscalation = makeVerifyStage('verify-after-escalation');

export async function verifySessionLiveness(
  deps: VerifiedStopLivenessDeps,
  stage: string,
  state: VerifiedStopState
): Promise<{ value: VerifiedStopState } | { reason: VerifiedStopSettled }> {
  try {
    const liveness = await gatherSessionLiveness(deps, state.session!);
    return { value: { ...state, liveness } };
  } catch (error) {
    return { reason: { settled: { status: 'error', stage, error, unwind: [] } } };
  }
}

export function claimVerifiedStopSession(
  claimSession: VerifiedStopFlowDeps['claimSession'],
  request: VerifiedStopRequest
): {
  stop: VerifiedStopState;
  missingSessionArm: typeof unregisterMissingSessionStage | undefined;
} {
  const session = claimSession(request.sessionId);
  return {
    stop: { sessionId: request.sessionId, session, notes: [], liveness: null, decision: null },
    missingSessionArm: session === null ? unregisterMissingSessionStage : undefined,
  };
}

export async function unregisterMissingSessionStage(
  unregisterSession: VerifiedStopFlowDeps['unregisterSession'],
  warn: VerifiedStopFlowDeps['warn'],
  stop: VerifiedStopState
): Promise<{ reason: VerifiedStopSettled }> {
  try {
    await unregisterSession(stop.sessionId);
  } catch (err) {
    warn(
      `TaskAgentManager.stopSessionsVerified: failed to unregister missing session ${stop.sessionId}:`,
      err
    );
  }
  return {
    reason: {
      settled: {
        status: 'completed',
        result: {
          sessionId: stop.sessionId,
          stopped: true,
          detail: 'no in-memory session; unregistered',
        },
      },
    },
  };
}

export async function interruptSession(
  stopSessionStrict: VerifiedStopFlowDeps['stopSessionStrict'],
  stop: VerifiedStopState
): Promise<{ stop: VerifiedStopState }> {
  try {
    await stopSessionStrict(stop.sessionId, stop.session!);
  } catch (err) {
    return { stop: { ...stop, notes: [...stop.notes, `interrupt failed: ${describeError(err)}`] } };
  }
  return { stop };
}

export function decideAfterFirstInterrupt(stop: VerifiedStopState): {
  stop: VerifiedStopState;
  retryArm: typeof retryInterrupt | undefined;
  retryVerifyArm: VerifiedStopVerifyStage | undefined;
  retryDecideArm: typeof decideAfterRetry | undefined;
} {
  const decision = decideStopVerification({
    sessionPresent: true,
    ...stop.liveness!,
    interruptAttemptsSoFar: 1,
    escalationDone: false,
  });
  const retrying = decision.action === 'retry_interrupt';
  return {
    stop: { ...stop, decision },
    retryArm: retrying ? retryInterrupt : undefined,
    retryVerifyArm: retrying ? verifyAfterRetry : undefined,
    retryDecideArm: retrying ? decideAfterRetry : undefined,
  };
}

export async function retryInterrupt(
  stopSessionStrict: VerifiedStopFlowDeps['stopSessionStrict'],
  warn: VerifiedStopFlowDeps['warn'],
  stop: VerifiedStopState
): Promise<{ stop: VerifiedStopState }> {
  warn(
    `TaskAgentManager.stopSessionsVerified: session ${stop.sessionId} still alive after interrupt (${retryReasonOf(stop.decision)}); retrying once`
  );
  try {
    await stopSessionStrict(stop.sessionId, stop.session!);
  } catch (err) {
    return {
      stop: { ...stop, notes: [...stop.notes, `retry interrupt failed: ${describeError(err)}`] },
    };
  }
  return { stop };
}

export function decideAfterRetry(stop: VerifiedStopState): {
  stop: VerifiedStopState;
  escalateArm: typeof escalateToTermination | undefined;
  escalateVerifyArm: VerifiedStopVerifyStage | undefined;
  escalateDecideArm: typeof decideFinalVerdict | undefined;
} {
  const decision = decideStopVerification({
    sessionPresent: true,
    ...stop.liveness!,
    interruptAttemptsSoFar: 2,
    escalationDone: false,
  });
  const escalating = decision.action === 'escalate_terminate';
  return {
    stop: {
      ...stop,
      decision,
      notes:
        decision.action === 'down'
          ? [...stop.notes, 'first interrupt did not land; stopped on retry']
          : stop.notes,
    },
    escalateArm: escalating ? escalateToTermination : undefined,
    escalateVerifyArm: escalating ? verifyAfterEscalation : undefined,
    escalateDecideArm: escalating ? decideFinalVerdict : undefined,
  };
}

export function escalateToTermination(
  terminateTrackedProcesses: VerifiedStopFlowDeps['terminateTrackedProcesses'],
  warn: VerifiedStopFlowDeps['warn'],
  stop: VerifiedStopState
): { stop: VerifiedStopState } {
  warn(
    `TaskAgentManager.stopSessionsVerified: session ${stop.sessionId} survived interrupt retry (${escalateReasonOf(stop.decision)}); escalating to tracked process termination`
  );
  const notes = [
    ...stop.notes,
    `escalated after verification failure (${escalateReasonOf(stop.decision)})`,
  ];
  try {
    terminateTrackedProcesses(stop.session!);
  } catch (err) {
    return { stop: { ...stop, notes: [...notes, `escalation failed: ${describeError(err)}`] } };
  }
  return { stop: { ...stop, notes } };
}

export function decideFinalVerdict(stop: VerifiedStopState): { stop: VerifiedStopState } {
  return {
    stop: {
      ...stop,
      decision: decideStopVerification({
        sessionPresent: true,
        ...stop.liveness!,
        interruptAttemptsSoFar: 2,
        escalationDone: true,
      }),
    },
  };
}

export async function finalizeVerifiedStop(
  detachSessionBookkeeping: VerifiedStopFlowDeps['detachSessionBookkeeping'],
  unregisterSession: VerifiedStopFlowDeps['unregisterSession'],
  warn: VerifiedStopFlowDeps['warn'],
  stop: VerifiedStopState
): Promise<{ reason: VerifiedStopSettled }> {
  detachSessionBookkeeping(stop.sessionId);
  let notes = stop.notes;
  try {
    await unregisterSession(stop.sessionId);
  } catch (err) {
    notes = [...notes, `unregister failed: ${describeError(err)}`];
  }
  const result: VerifiedSessionStop = assembleVerifiedStopResult({
    sessionId: stop.sessionId,
    notes,
    decision: stop.decision!,
  });
  return { reason: { settled: { status: 'completed', result } } };
}

const LIVENESS_INPUTS = [
  'readProcessingStatus',
  'isInterruptInProgress',
  'awaitProcessExitSettle',
  'readLivePids',
] as const;

export function runVerifiedStopFlow(
  deps: VerifiedStopFlowDeps,
  sessionId: string
): Promise<FlowOutcome> {
  const run = (
    superpipe({
      claimSession: deps.claimSession,
      stopSessionStrict: deps.stopSessionStrict,
      readProcessingStatus: deps.readProcessingStatus,
      isInterruptInProgress: deps.isInterruptInProgress,
      awaitProcessExitSettle: deps.awaitProcessExitSettle,
      readLivePids: deps.readLivePids,
      terminateTrackedProcesses: deps.terminateTrackedProcesses,
      unregisterSession: deps.unregisterSession,
      detachSessionBookkeeping: deps.detachSessionBookkeeping,
      warn: deps.warn,
    })('verified-stop') as PipelineAPI
  )
    .input('request')
    .pipe(claimVerifiedStopSession, ['claimSession', 'request'], ['stop', 'missingSessionArm'])
    .pipe('?missingSessionArm', ['unregisterSession', 'warn', 'stop'], 'result:stop')
    .pipe(interruptSession, ['stopSessionStrict', 'stop'], ['stop'])
    .pipe(verifyAfterInterrupt, [...LIVENESS_INPUTS, 'stop'], 'result:stop')
    .pipe(decideAfterFirstInterrupt, 'stop', [
      'stop',
      'retryArm',
      'retryVerifyArm',
      'retryDecideArm',
    ])
    .pipe('?retryArm', ['stopSessionStrict', 'warn', 'stop'], ['stop'])
    .pipe('?retryVerifyArm', [...LIVENESS_INPUTS, 'stop'], 'result:stop')
    .pipe('?retryDecideArm', 'stop', [
      'stop',
      'escalateArm',
      'escalateVerifyArm',
      'escalateDecideArm',
    ])
    .pipe('?escalateArm', ['terminateTrackedProcesses', 'warn', 'stop'], ['stop'])
    .pipe('?escalateVerifyArm', [...LIVENESS_INPUTS, 'stop'], 'result:stop')
    .pipe('?escalateDecideArm', 'stop', ['stop'])
    .pipe(
      finalizeVerifiedStop,
      ['detachSessionBookkeeping', 'unregisterSession', 'warn', 'stop'],
      'result:stop'
    )
    .endAsync('stop') as (request: VerifiedStopRequest) => Promise<VerifiedStopOutcome>;

  return run({ sessionId }).then(
    (outcome) => (isVerifiedStopSettled(outcome) ? outcome.settled : { status: 'completed' }),
    (error: unknown) => ({ status: 'error', stage: undefined, error, unwind: [] })
  );
}
