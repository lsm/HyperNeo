import {
  isRateOrUsageLimited,
  isWorkflowRunSucceeded,
  isWorkflowRunWaiting,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI, type Result } from 'superpipe';
import type {
  RunTickAdmissionDecision,
  RunTickAdmissionInput,
} from './run-tick-admission-gates.ts';

export type RunTickDecisionCtx = RunTickAdmissionInput;
type RunTickDecisionResult = Result<RunTickDecisionCtx, RunTickAdmissionDecision>;

function decided(decision: RunTickAdmissionDecision): RunTickDecisionResult {
  return { reason: decision };
}

function continued(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return { value: ctx };
}

function readLazyInput<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export function applyMissingRunGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return ctx.runStatus === null
    ? decided({ action: 'skip', reason: 'missing_run' })
    : continued(ctx);
}

export function applyFinishedRunGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  const { runStatus } = ctx;
  if (runStatus === null) return continued(ctx);
  if (runStatus === 'cancelled' || isWorkflowRunSucceeded(runStatus)) {
    return decided({ action: 'clearFinishedRun' });
  }
  return continued(ctx);
}

export function applyWaitingRunGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  const { runStatus } = ctx;
  return runStatus !== null && isWorkflowRunWaiting(runStatus)
    ? decided({ action: 'recoverWaitingRun' })
    : continued(ctx);
}

export function applyExecutorMetaGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return ctx.hasExecutorMeta
    ? continued(ctx)
    : decided({ action: 'skip', reason: 'no_executor_meta' });
}

export function applyRunTasksGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return ctx.runTaskCount > 0
    ? continued(ctx)
    : decided({ action: 'skip', reason: 'no_run_tasks' });
}

export function applyCanonicalTaskGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return ctx.hasCanonicalTask
    ? continued(ctx)
    : decided({ action: 'skip', reason: 'no_canonical_task' });
}

export function applyWorkflowValidityGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return ctx.hasEndNodeId ? continued(ctx) : decided({ action: 'blockInvalidWorkflow' });
}

export function applyRateLimitGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return ctx.canonicalTaskStatus !== null && isRateOrUsageLimited(ctx.canonicalTaskStatus)
    ? decided({ action: 'skip', reason: 'rate_or_usage_limited' })
    : continued(ctx);
}

export function applyTaskStoppedGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return ctx.canonicalTaskStatus === 'stopped'
    ? decided({ action: 'skip', reason: 'task_stopped' })
    : continued(ctx);
}

export function applyExecutionsPresentGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return readLazyInput(ctx.executionCount) > 0
    ? continued(ctx)
    : decided({ action: 'skip', reason: 'no_executions' });
}

export function applyBlockedExecutionsGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  if (readLazyInput(ctx.runIsComplete)) return continued(ctx);
  if (!readLazyInput(ctx.hasBlockedExecution)) return continued(ctx);
  return decided({
    action: 'blockOnBlockedExecutions',
    blockedReason:
      readLazyInput(ctx.firstBlockedResult) ?? 'One or more workflow agents are blocked',
  });
}

export function applySlotAvailabilityGate(ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return ctx.canonicalTaskStatus === 'open' && ctx.availableTaskSlots <= 0
    ? decided({ action: 'deferNoAvailableSlots' })
    : continued(ctx);
}

export function applyProceedGate(_ctx: RunTickDecisionCtx): RunTickDecisionResult {
  return decided({ action: 'proceed' });
}

const runTickAdmissionDecisionRun = (superpipe()('run-tick-admission') as PipelineAPI)
  .input(['ctx'])
  .pipe(applyMissingRunGate, 'ctx', 'result:decision')
  .pipe(applyFinishedRunGate, 'ctx', 'result:decision')
  .pipe(applyWaitingRunGate, 'ctx', 'result:decision')
  .pipe(applyExecutorMetaGate, 'ctx', 'result:decision')
  .pipe(applyRunTasksGate, 'ctx', 'result:decision')
  .pipe(applyCanonicalTaskGate, 'ctx', 'result:decision')
  .pipe(applyWorkflowValidityGate, 'ctx', 'result:decision')
  .pipe(applyRateLimitGate, 'ctx', 'result:decision')
  .pipe(applyTaskStoppedGate, 'ctx', 'result:decision')
  .pipe(applyExecutionsPresentGate, 'ctx', 'result:decision')
  .pipe(applyBlockedExecutionsGate, 'ctx', 'result:decision')
  .pipe(applySlotAvailabilityGate, 'ctx', 'result:decision')
  .pipe(applyProceedGate, 'ctx', 'result:decision')
  .end('decision');

export function decideRunTickAdmissionViaPipeline(
  input: RunTickAdmissionInput
): RunTickAdmissionDecision {
  return runTickAdmissionDecisionRun(input) as RunTickAdmissionDecision;
}
