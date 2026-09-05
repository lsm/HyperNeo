import { isRateOrUsageLimited } from '@hyperneo/shared';
import superpipe, { type PipelineAPI, type Result } from 'superpipe';
import type {
  SpawnExecutionAdmissionDecision,
  SpawnExecutionAdmissionInput,
} from './spawn-admission-gates.ts';

export type SpawnAdmissionCtx = SpawnExecutionAdmissionInput;
type SpawnAdmissionResult = Result<SpawnAdmissionCtx, SpawnExecutionAdmissionDecision>;

function decided(decision: SpawnExecutionAdmissionDecision): SpawnAdmissionResult {
  return { reason: decision };
}

function continued(ctx: SpawnAdmissionCtx): SpawnAdmissionResult {
  return { value: ctx };
}

export function applyLiveSessionGate(ctx: SpawnAdmissionCtx): SpawnAdmissionResult {
  return ctx.hasLiveIndexedSession ? decided({ action: 'reuse_live' }) : continued(ctx);
}

export function applyConcurrentSpawnGate(ctx: SpawnAdmissionCtx): SpawnAdmissionResult {
  return ctx.isSpawningExecution ? decided({ action: 'wait_concurrent' }) : continued(ctx);
}

export function applyTaskStatusGate(ctx: SpawnAdmissionCtx): SpawnAdmissionResult {
  if (ctx.taskStatus === 'archived') {
    return decided({ action: 'reject_permanent', reason: 'task_archived' });
  }
  if (ctx.taskStatus === 'cancelled') {
    return decided({ action: 'reject_permanent', reason: 'task_cancelled' });
  }
  if (isRateOrUsageLimited(ctx.taskStatus)) {
    return decided({ action: 'reject_transient', reason: 'task_rate_or_usage_limited' });
  }
  return continued(ctx);
}

export function applyWorkflowValidityGate(ctx: SpawnAdmissionCtx): SpawnAdmissionResult {
  return ctx.executionWorkflowValid
    ? continued(ctx)
    : decided({ action: 'reject_permanent', reason: 'workflow_invalid' });
}

export function applySlotResolutionGate(ctx: SpawnAdmissionCtx): SpawnAdmissionResult {
  return ctx.slotResolvable
    ? continued(ctx)
    : decided({ action: 'reject_permanent', reason: 'slot_unresolvable' });
}

export function applyProceedGate(_ctx: SpawnAdmissionCtx): SpawnAdmissionResult {
  return decided({ action: 'proceed_fresh' });
}

const spawnAdmissionDecisionRun = (superpipe()('spawn-execution-admission') as PipelineAPI)
  .input(['ctx'])
  .pipe(applyLiveSessionGate, 'ctx', 'result:decision')
  .pipe(applyConcurrentSpawnGate, 'ctx', 'result:decision')
  .pipe(applyTaskStatusGate, 'ctx', 'result:decision')
  .pipe(applyWorkflowValidityGate, 'ctx', 'result:decision')
  .pipe(applySlotResolutionGate, 'ctx', 'result:decision')
  .pipe(applyProceedGate, 'ctx', 'result:decision')
  .end('decision');

export function decideSpawnExecutionAdmissionViaPipeline(
  input: SpawnExecutionAdmissionInput
): SpawnExecutionAdmissionDecision {
  return spawnAdmissionDecisionRun(input) as SpawnExecutionAdmissionDecision;
}
