import type { AgentProcessingState } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { AgentSession } from '../agent/agent-session.ts';
import type { StagedRunOutcome } from '../space/runtime/staged-run.ts';
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

interface VerifiedStopCtx {
  deps: VerifiedStopFlowDeps;
  sessionId: string;
  session: AgentSession | null;
  notes: string[];
  retryReason: string | null;
  escalateReason: string | null;
  liveness: SessionLivenessSnapshot;
  decision: StopVerificationDecision | null;
  outcome: VerifiedSessionStop | null;
  failure: { stage: string; error: unknown } | null;
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

function claimSession(ctx: VerifiedStopCtx): VerifiedStopCtx {
  return { ...ctx, session: ctx.deps.claimSession(ctx.sessionId) };
}

async function interruptSession(ctx: VerifiedStopCtx): Promise<VerifiedStopCtx> {
  if (ctx.session === null) return ctx;
  try {
    await ctx.deps.stopSessionStrict(ctx.sessionId, ctx.session);
  } catch (err) {
    return { ...ctx, notes: [...ctx.notes, `interrupt failed: ${describeError(err)}`] };
  }
  return ctx;
}

async function verifyLiveness(ctx: VerifiedStopCtx, stage: string): Promise<VerifiedStopCtx> {
  if (ctx.session === null || ctx.failure !== null) return ctx;
  try {
    return { ...ctx, liveness: await gatherSessionLiveness(ctx.deps, ctx.session) };
  } catch (error) {
    return { ...ctx, failure: { stage, error } };
  }
}

function verifyAfterFirstInterrupt(ctx: VerifiedStopCtx): Promise<VerifiedStopCtx> {
  return verifyLiveness(ctx, 'verify-after-interrupt');
}

function verifyAfterRetry(ctx: VerifiedStopCtx): Promise<VerifiedStopCtx> {
  if (ctx.retryReason === null) return Promise.resolve(ctx);
  return verifyLiveness(ctx, 'verify-after-retry');
}

function verifyAfterEscalation(ctx: VerifiedStopCtx): Promise<VerifiedStopCtx> {
  if (ctx.escalateReason === null) return Promise.resolve(ctx);
  return verifyLiveness(ctx, 'verify-after-escalation');
}

function decideAfterFirstInterrupt(ctx: VerifiedStopCtx): VerifiedStopCtx {
  if (ctx.session === null || ctx.failure !== null) return ctx;
  const decision = decideStopVerification({
    sessionPresent: true,
    processingStatus: ctx.liveness.processingStatus,
    interruptInProgress: ctx.liveness.interruptInProgress,
    livePids: ctx.liveness.livePids,
    interruptAttemptsSoFar: 1,
    escalationDone: false,
  });
  return {
    ...ctx,
    decision,
    retryReason: decision.action === 'retry_interrupt' ? decision.reason : null,
  };
}

async function retryInterrupt(ctx: VerifiedStopCtx): Promise<VerifiedStopCtx> {
  if (ctx.failure !== null || ctx.session === null || ctx.retryReason === null) return ctx;
  ctx.deps.warn(
    `TaskAgentManager.stopSessionsVerified: session ${ctx.sessionId} still alive after interrupt (${ctx.retryReason}); retrying once`
  );
  try {
    await ctx.deps.stopSessionStrict(ctx.sessionId, ctx.session);
  } catch (err) {
    return { ...ctx, notes: [...ctx.notes, `retry interrupt failed: ${describeError(err)}`] };
  }
  return ctx;
}

function decideAfterRetry(ctx: VerifiedStopCtx): VerifiedStopCtx {
  if (ctx.failure !== null || ctx.retryReason === null) return ctx;
  const decision = decideStopVerification({
    sessionPresent: true,
    processingStatus: ctx.liveness.processingStatus,
    interruptInProgress: ctx.liveness.interruptInProgress,
    livePids: ctx.liveness.livePids,
    interruptAttemptsSoFar: 2,
    escalationDone: false,
  });
  return {
    ...ctx,
    decision,
    notes:
      decision.action === 'down'
        ? [...ctx.notes, 'first interrupt did not land; stopped on retry']
        : ctx.notes,
    escalateReason: decision.action === 'escalate_terminate' ? decision.reason : null,
  };
}

function terminateTrackedProcesses(ctx: VerifiedStopCtx): VerifiedStopCtx {
  if (ctx.failure !== null || ctx.escalateReason === null) return ctx;
  ctx.deps.warn(
    `TaskAgentManager.stopSessionsVerified: session ${ctx.sessionId} survived interrupt retry (${ctx.escalateReason}); escalating to tracked process termination`
  );
  const notes = [...ctx.notes, `escalated after verification failure (${ctx.escalateReason})`];
  try {
    ctx.deps.terminateTrackedProcesses(ctx.session!);
  } catch (err) {
    return { ...ctx, notes: [...notes, `escalation failed: ${describeError(err)}`] };
  }
  return { ...ctx, notes };
}

function decideFinalVerdict(ctx: VerifiedStopCtx): VerifiedStopCtx {
  if (ctx.failure !== null || ctx.escalateReason === null) return ctx;
  return {
    ...ctx,
    decision: decideStopVerification({
      sessionPresent: true,
      processingStatus: ctx.liveness.processingStatus,
      interruptInProgress: ctx.liveness.interruptInProgress,
      livePids: ctx.liveness.livePids,
      interruptAttemptsSoFar: 2,
      escalationDone: true,
    }),
  };
}

async function detachAndUnregister(ctx: VerifiedStopCtx): Promise<VerifiedStopCtx> {
  if (ctx.failure !== null || ctx.session === null) return ctx;
  ctx.deps.detachSessionBookkeeping(ctx.sessionId);
  try {
    await ctx.deps.unregisterSession(ctx.sessionId);
  } catch (err) {
    return { ...ctx, notes: [...ctx.notes, `unregister failed: ${describeError(err)}`] };
  }
  return ctx;
}

async function unregisterMissingSession(ctx: VerifiedStopCtx): Promise<VerifiedStopCtx> {
  if (ctx.session !== null) return ctx;
  try {
    await ctx.deps.unregisterSession(ctx.sessionId);
  } catch (err) {
    ctx.deps.warn(
      `TaskAgentManager.stopSessionsVerified: failed to unregister missing session ${ctx.sessionId}:`,
      err
    );
  }
  return {
    ...ctx,
    outcome: {
      sessionId: ctx.sessionId,
      stopped: true,
      detail: 'no in-memory session; unregistered',
    },
  };
}

function assembleVerdict(ctx: VerifiedStopCtx): VerifiedStopCtx {
  if (ctx.failure !== null || ctx.session === null) return ctx;
  return {
    ...ctx,
    outcome: assembleVerifiedStopResult({
      sessionId: ctx.sessionId,
      notes: ctx.notes,
      decision: ctx.decision!,
    }),
  };
}

const run = (superpipe({})('verified-stop-flow') as PipelineAPI)
  .input(['ctx'])
  .pipe(claimSession, 'ctx', 'ctx')
  .pipe(interruptSession, 'ctx', 'ctx')
  .pipe(verifyAfterFirstInterrupt, 'ctx', 'ctx')
  .pipe(decideAfterFirstInterrupt, 'ctx', 'ctx')
  .pipe(retryInterrupt, 'ctx', 'ctx')
  .pipe(verifyAfterRetry, 'ctx', 'ctx')
  .pipe(decideAfterRetry, 'ctx', 'ctx')
  .pipe(terminateTrackedProcesses, 'ctx', 'ctx')
  .pipe(verifyAfterEscalation, 'ctx', 'ctx')
  .pipe(decideFinalVerdict, 'ctx', 'ctx')
  .pipe(detachAndUnregister, 'ctx', 'ctx')
  .pipe(unregisterMissingSession, 'ctx', 'ctx')
  .pipe(assembleVerdict, 'ctx', 'ctx')
  .endAsync('ctx') as (input: VerifiedStopCtx) => Promise<VerifiedStopCtx>;

export async function runVerifiedStopFlow(
  deps: VerifiedStopFlowDeps,
  sessionId: string
): Promise<StagedRunOutcome> {
  const ctx: VerifiedStopCtx = {
    deps,
    sessionId,
    session: null,
    notes: [],
    retryReason: null,
    escalateReason: null,
    liveness: { processingStatus: 'processing', interruptInProgress: false, livePids: [] },
    decision: null,
    outcome: null,
    failure: null,
  };
  try {
    const final = await run(ctx);
    if (final.failure !== null) {
      return {
        status: 'error',
        stage: final.failure.stage,
        error: final.failure.error,
        unwind: [],
      };
    }
    return { status: 'completed', result: final.outcome };
  } catch (error) {
    return { status: 'error', stage: undefined, error, unwind: [] };
  }
}
