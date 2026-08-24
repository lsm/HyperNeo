import type { AgentProcessingState } from '@hyperneo/shared';
import type { AgentSession } from '../../../lib/agent/agent-session.ts';
import {
  assembleVerifiedStopResult,
  decideStopVerification,
  isStopDownProcessingStatus,
  type SessionLivenessSnapshot,
  type StopVerificationDecision,
} from './stop-verification-gates.ts';
import { stagedRun, type StagedRunOutcome } from './staged-run.ts';

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

interface VerifiedStopFlowState {
  sessionId: string;
  session: AgentSession | null;
  processingStatus: AgentProcessingState['status'];
  interruptInProgress: boolean;
  livePids: readonly number[];
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function gatherSessionLiveness(
  deps: VerifiedStopFlowDeps,
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

export function runVerifiedStopFlow(
  deps: VerifiedStopFlowDeps,
  sessionId: string
): Promise<StagedRunOutcome> {
  const notes: string[] = [];
  const flow = stagedRun<VerifiedStopFlowState>(
    'verified-stop',
    (s) => [
      s.snapshot({
        name: 'claim-session',
        provides: ['session'],
        reads: ['sessionId'],
        run: (view) => ({ session: deps.claimSession(view.sessionId) }),
      }),
      s.decide({
        name: 'session-presence',
        reads: ['session'],
        branches: ['missing', 'present'],
        run: (view) =>
          view.session === null
            ? { decision: { action: 'missing' }, missing: true }
            : { decision: { action: 'interrupt' }, present: true },
      }),
      s.effect({
        name: 'unregister-missing-session',
        when: 'missing',
        reads: ['sessionId'],
        writes: [],
        run: async (view) => {
          try {
            await deps.unregisterSession(view.sessionId);
          } catch (err) {
            deps.warn(
              `TaskAgentManager.stopSessionsVerified: failed to unregister missing session ${view.sessionId}:`,
              err
            );
          }
        },
      }),
      s.halt({
        name: 'missing-verdict',
        when: 'missing',
        reads: ['sessionId'],
        run: (view) => ({
          sessionId: view.sessionId,
          stopped: true,
          detail: 'no in-memory session; unregistered',
        }),
      }),
      s.effect({
        name: 'interrupt-session',
        when: 'present',
        reads: ['sessionId', 'session'],
        writes: [],
        run: async (view) => {
          try {
            await deps.stopSessionStrict(view.sessionId, view.session!);
          } catch (err) {
            notes.push(`interrupt failed: ${describeError(err)}`);
          }
        },
      }),
      s.resnapshot({
        name: 'verify-after-interrupt',
        when: 'present',
        provides: ['processingStatus', 'interruptInProgress', 'livePids'],
        reads: ['session'],
        run: (view) => gatherSessionLiveness(deps, view.session!),
      }),
      s.decide({
        name: 'verdict-after-first-interrupt',
        when: 'present',
        reads: ['processingStatus', 'interruptInProgress', 'livePids'],
        branches: ['downAfterFirstInterrupt', 'retryInterrupt'],
        run: (view) => {
          const decision = decideStopVerification({
            sessionPresent: true,
            processingStatus: view.processingStatus,
            interruptInProgress: view.interruptInProgress,
            livePids: view.livePids,
            interruptAttemptsSoFar: 1,
            escalationDone: false,
          });
          if (decision.action === 'down') {
            return { decision, downAfterFirstInterrupt: true };
          }
          if (decision.action === 'retry_interrupt') {
            return { decision, retryInterrupt: { reason: decision.reason } };
          }
          return { decision };
        },
      }),
      s.effect({
        name: 'retry-interrupt',
        when: 'retryInterrupt',
        reads: ['sessionId', 'session'],
        writes: [],
        run: async (view) => {
          const reason = (view.retryInterrupt as { reason: string }).reason;
          deps.warn(
            `TaskAgentManager.stopSessionsVerified: session ${view.sessionId} still alive after interrupt (${reason}); retrying once`
          );
          try {
            await deps.stopSessionStrict(view.sessionId, view.session!);
          } catch (err) {
            notes.push(`retry interrupt failed: ${describeError(err)}`);
          }
        },
      }),
      s.resnapshot({
        name: 'verify-after-retry',
        when: 'retryInterrupt',
        provides: ['processingStatus', 'interruptInProgress', 'livePids'],
        reads: ['session'],
        run: (view) => gatherSessionLiveness(deps, view.session!),
      }),
      s.decide({
        name: 'verdict-after-retry',
        when: 'retryInterrupt',
        reads: ['processingStatus', 'interruptInProgress', 'livePids'],
        branches: ['downAfterRetry', 'escalateTerminate'],
        run: (view) => {
          const decision = decideStopVerification({
            sessionPresent: true,
            processingStatus: view.processingStatus,
            interruptInProgress: view.interruptInProgress,
            livePids: view.livePids,
            interruptAttemptsSoFar: 2,
            escalationDone: false,
          });
          if (decision.action === 'down') {
            return { decision, downAfterRetry: true };
          }
          if (decision.action === 'escalate_terminate') {
            return { decision, escalateTerminate: { reason: decision.reason } };
          }
          return { decision };
        },
      }),
      s.effect({
        name: 'note-stopped-on-retry',
        when: 'downAfterRetry',
        reads: [],
        writes: [],
        run: () => {
          notes.push('first interrupt did not land; stopped on retry');
        },
      }),
      s.effect({
        name: 'terminate-tracked-processes',
        when: 'escalateTerminate',
        reads: ['sessionId', 'session'],
        writes: [],
        run: (view) => {
          const reason = (view.escalateTerminate as { reason: string }).reason;
          deps.warn(
            `TaskAgentManager.stopSessionsVerified: session ${view.sessionId} survived interrupt retry (${reason}); escalating to tracked process termination`
          );
          notes.push(`escalated after verification failure (${reason})`);
          try {
            deps.terminateTrackedProcesses(view.session!);
          } catch (err) {
            notes.push(`escalation failed: ${describeError(err)}`);
          }
        },
      }),
      s.resnapshot({
        name: 'verify-after-escalation',
        when: 'escalateTerminate',
        provides: ['processingStatus', 'interruptInProgress', 'livePids'],
        reads: ['session'],
        run: (view) => gatherSessionLiveness(deps, view.session!),
      }),
      s.decide({
        name: 'final-verdict',
        when: 'escalateTerminate',
        reads: ['processingStatus', 'interruptInProgress', 'livePids'],
        run: (view) => ({
          decision: decideStopVerification({
            sessionPresent: true,
            processingStatus: view.processingStatus,
            interruptInProgress: view.interruptInProgress,
            livePids: view.livePids,
            interruptAttemptsSoFar: 2,
            escalationDone: true,
          }),
        }),
      }),
      s.effect({
        name: 'detach-and-unregister',
        reads: ['sessionId'],
        writes: [],
        run: async (view) => {
          deps.detachSessionBookkeeping(view.sessionId);
          try {
            await deps.unregisterSession(view.sessionId);
          } catch (err) {
            notes.push(`unregister failed: ${describeError(err)}`);
          }
        },
      }),
      s.halt({
        name: 'stop-verdict',
        reads: ['sessionId', 'decision'],
        run: (view) =>
          assembleVerifiedStopResult({
            sessionId: view.sessionId,
            notes,
            decision: view.decision as StopVerificationDecision,
          }),
      }),
    ],
    { input: ['sessionId'] }
  );
  return flow({ sessionId });
}
