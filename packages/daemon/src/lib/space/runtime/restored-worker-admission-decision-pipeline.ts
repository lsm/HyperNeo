import type { NodeExecution, Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import { decisionRun } from './decision-pipeline.ts';
import { isCanonicalTaskTerminalForSpawn } from './run-spawn-decisions.ts';

export interface RestoredWorkerAdmissionInput {
  settleReplayProvisioning: boolean;
  queryMode: 'immediate' | 'manual' | undefined;
  daemonCleaningUp: boolean;
  task: SpaceTask | null;
  workflowRun: SpaceWorkflowRun | null;
  space: Space | null;
  sessionId: string;
  sessionStatus: string | (() => string);
  execution: NodeExecution | null | (() => NodeExecution | null);
  hasQueuedRetryableHookAction: boolean | (() => boolean);
}

export interface RestoredWorkerAdmissionCtx extends RestoredWorkerAdmissionInput {
  decision: boolean | null;
}

function decided(ctx: RestoredWorkerAdmissionCtx, admitted: boolean): RestoredWorkerAdmissionCtx {
  return { ...ctx, decision: admitted };
}

function readLazyInput<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export function applyManualQueryModeGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionCtx {
  return !ctx.settleReplayProvisioning && ctx.queryMode === 'manual' ? decided(ctx, false) : ctx;
}

export function applyDaemonCleanupGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionCtx {
  return ctx.daemonCleaningUp ? decided(ctx, false) : ctx;
}

export function applyTaskWorkflowGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  return ctx.task?.workflowRunId ? ctx : decided(ctx, false);
}

export function applyTaskTerminalGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  return ctx.task?.status === 'cancelled' || ctx.task?.status === 'archived'
    ? decided(ctx, false)
    : ctx;
}

export function applyWorkflowRunGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  return ctx.workflowRun !== null && ctx.workflowRun.status !== 'cancelled'
    ? ctx
    : decided(ctx, false);
}

export function applySessionStatusGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionCtx {
  const sessionStatus = readLazyInput(ctx.sessionStatus);
  return sessionStatus === 'archived' || sessionStatus === 'ended' ? decided(ctx, false) : ctx;
}

export function applySpaceGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  const space = ctx.space;
  return space !== null && !space.stopped && !space.paused && space.status !== 'archived'
    ? ctx
    : decided(ctx, false);
}

export function applyPostApprovalGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  return ctx.sessionId.includes(':post-approval:')
    ? decided(ctx, ctx.task?.status === 'approved')
    : ctx;
}

export function applyTerminalForSpawnGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionCtx {
  return ctx.task !== null &&
    (isCanonicalTaskTerminalForSpawn(ctx.task.status) || ctx.workflowRun?.status === 'done')
    ? decided(ctx, false)
    : ctx;
}

export function applyExecutionPresenceGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionCtx {
  return readLazyInput(ctx.execution) !== null ? ctx : decided(ctx, false);
}

export function applyExecutionResumableGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionCtx {
  const execution = readLazyInput(ctx.execution);
  if (execution === null) return ctx;
  if (execution.status === 'in_progress' || execution.status === 'blocked') return ctx;
  return readLazyInput(ctx.hasQueuedRetryableHookAction) ? ctx : decided(ctx, false);
}

export function applyAdmitGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  return decided(ctx, true);
}

const restoredWorkerAdmissionRun = decisionRun('restored-worker-start-admission', [
  applyManualQueryModeGate,
  applyDaemonCleanupGate,
  applyTaskWorkflowGate,
  applyTaskTerminalGate,
  applyWorkflowRunGate,
  applySessionStatusGate,
  applySpaceGate,
  applyPostApprovalGate,
  applyTerminalForSpawnGate,
  applyExecutionPresenceGate,
  applyExecutionResumableGate,
  applyAdmitGate,
]);

export function decideRestoredWorkerAdmission(input: RestoredWorkerAdmissionInput): boolean {
  return restoredWorkerAdmissionRun(input).decision ?? false;
}
