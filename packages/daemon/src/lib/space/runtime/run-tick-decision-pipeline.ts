import {
  isRateOrUsageLimited,
  isWorkflowRunSucceeded,
  isWorkflowRunWaiting,
} from '@hyperneo/shared';
import { decisionRun } from './decision-pipeline';
import type { RunTickAdmissionDecision, RunTickAdmissionInput } from './run-tick-admission-gates';

export interface RunTickDecisionCtx extends RunTickAdmissionInput {
  decision: RunTickAdmissionDecision | null;
}

function decided(ctx: RunTickDecisionCtx, decision: RunTickAdmissionDecision): RunTickDecisionCtx {
  return { ...ctx, decision };
}

function readLazyInput<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export function applyMissingRunGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return ctx.runStatus === null ? decided(ctx, { action: 'skip', reason: 'missing_run' }) : ctx;
}

export function applyFinishedRunGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  const { runStatus } = ctx;
  if (runStatus === null) return ctx;
  if (runStatus === 'cancelled' || isWorkflowRunSucceeded(runStatus)) {
    return decided(ctx, { action: 'clearFinishedRun' });
  }
  return ctx;
}

export function applyWaitingRunGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  const { runStatus } = ctx;
  return runStatus !== null && isWorkflowRunWaiting(runStatus)
    ? decided(ctx, { action: 'recoverWaitingRun' })
    : ctx;
}

export function applyExecutorMetaGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return ctx.hasExecutorMeta ? ctx : decided(ctx, { action: 'skip', reason: 'no_executor_meta' });
}

export function applyRunTasksGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return ctx.runTaskCount > 0 ? ctx : decided(ctx, { action: 'skip', reason: 'no_run_tasks' });
}

export function applyCanonicalTaskGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return ctx.hasCanonicalTask ? ctx : decided(ctx, { action: 'skip', reason: 'no_canonical_task' });
}

export function applyWorkflowValidityGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return ctx.hasEndNodeId ? ctx : decided(ctx, { action: 'blockInvalidWorkflow' });
}

export function applyRateLimitGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return ctx.canonicalTaskStatus !== null && isRateOrUsageLimited(ctx.canonicalTaskStatus)
    ? decided(ctx, { action: 'skip', reason: 'rate_or_usage_limited' })
    : ctx;
}

export function applyTaskStoppedGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return ctx.canonicalTaskStatus === 'stopped'
    ? decided(ctx, { action: 'skip', reason: 'task_stopped' })
    : ctx;
}

export function applyExecutionsPresentGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return readLazyInput(ctx.executionCount) > 0
    ? ctx
    : decided(ctx, { action: 'skip', reason: 'no_executions' });
}

export function applyBlockedExecutionsGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  if (readLazyInput(ctx.runIsComplete)) return ctx;
  if (!readLazyInput(ctx.hasBlockedExecution)) return ctx;
  return decided(ctx, {
    action: 'blockOnBlockedExecutions',
    blockedReason:
      readLazyInput(ctx.firstBlockedResult) ?? 'One or more workflow agents are blocked',
  });
}

export function applySlotAvailabilityGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return ctx.canonicalTaskStatus === 'open' && ctx.availableTaskSlots <= 0
    ? decided(ctx, { action: 'deferNoAvailableSlots' })
    : ctx;
}

export function applyProceedGate(ctx: RunTickDecisionCtx): RunTickDecisionCtx {
  return decided(ctx, { action: 'proceed' });
}

const runTickAdmissionDecisionRun = decisionRun('run-tick-admission', [
  applyMissingRunGate,
  applyFinishedRunGate,
  applyWaitingRunGate,
  applyExecutorMetaGate,
  applyRunTasksGate,
  applyCanonicalTaskGate,
  applyWorkflowValidityGate,
  applyRateLimitGate,
  applyTaskStoppedGate,
  applyExecutionsPresentGate,
  applyBlockedExecutionsGate,
  applySlotAvailabilityGate,
  applyProceedGate,
]);

export function decideRunTickAdmissionViaPipeline(
  input: RunTickAdmissionInput
): RunTickAdmissionDecision {
  const ctx = runTickAdmissionDecisionRun(input);
  return ctx.decision ?? { action: 'proceed' };
}
