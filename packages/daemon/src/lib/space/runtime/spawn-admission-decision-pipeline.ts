import { isRateOrUsageLimited } from '@hyperneo/shared';
import { decisionRun } from './decision-pipeline.ts';
import type {
  SpawnExecutionAdmissionDecision,
  SpawnExecutionAdmissionInput,
} from './spawn-admission-gates.ts';

export interface SpawnAdmissionCtx extends SpawnExecutionAdmissionInput {
  decision: SpawnExecutionAdmissionDecision | null;
}

function decided(
  ctx: SpawnAdmissionCtx,
  decision: SpawnExecutionAdmissionDecision
): SpawnAdmissionCtx {
  return { ...ctx, decision };
}

export function applyLiveSessionGate(ctx: SpawnAdmissionCtx): SpawnAdmissionCtx {
  return ctx.hasLiveIndexedSession ? decided(ctx, { action: 'reuse_live' }) : ctx;
}

export function applyConcurrentSpawnGate(ctx: SpawnAdmissionCtx): SpawnAdmissionCtx {
  return ctx.isSpawningExecution ? decided(ctx, { action: 'wait_concurrent' }) : ctx;
}

export function applyTaskStatusGate(ctx: SpawnAdmissionCtx): SpawnAdmissionCtx {
  if (ctx.taskStatus === 'archived') {
    return decided(ctx, { action: 'reject_permanent', reason: 'task_archived' });
  }
  if (ctx.taskStatus === 'cancelled') {
    return decided(ctx, { action: 'reject_permanent', reason: 'task_cancelled' });
  }
  if (isRateOrUsageLimited(ctx.taskStatus)) {
    return decided(ctx, { action: 'reject_transient', reason: 'task_rate_or_usage_limited' });
  }
  return ctx;
}

export function applyWorkflowValidityGate(ctx: SpawnAdmissionCtx): SpawnAdmissionCtx {
  return ctx.executionWorkflowValid
    ? ctx
    : decided(ctx, { action: 'reject_permanent', reason: 'workflow_invalid' });
}

export function applySlotResolutionGate(ctx: SpawnAdmissionCtx): SpawnAdmissionCtx {
  return ctx.slotResolvable
    ? ctx
    : decided(ctx, { action: 'reject_permanent', reason: 'slot_unresolvable' });
}

export function applyProceedGate(ctx: SpawnAdmissionCtx): SpawnAdmissionCtx {
  return decided(ctx, { action: 'proceed_fresh' });
}

const spawnAdmissionDecisionRun = decisionRun('spawn-execution-admission', [
  applyLiveSessionGate,
  applyConcurrentSpawnGate,
  applyTaskStatusGate,
  applyWorkflowValidityGate,
  applySlotResolutionGate,
  applyProceedGate,
]);

export function decideSpawnExecutionAdmissionViaPipeline(
  input: SpawnExecutionAdmissionInput
): SpawnExecutionAdmissionDecision {
  return spawnAdmissionDecisionRun(input).decision ?? { action: 'proceed_fresh' };
}
