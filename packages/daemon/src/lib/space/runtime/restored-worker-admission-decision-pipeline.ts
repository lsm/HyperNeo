import type { NodeExecution, Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import { decisionRun } from './decision-pipeline.ts';
import { isCanonicalTaskTerminalForSpawn } from './run-spawn-decisions.ts';

export interface RestoredWorkerPreSpaceInput {
  settleReplayProvisioning: boolean;
  queryMode: 'immediate' | 'manual' | undefined;
  daemonCleaningUp: boolean;
  task: SpaceTask | null | (() => SpaceTask | null);
  workflowRun: SpaceWorkflowRun | null | (() => SpaceWorkflowRun | null);
}

export interface RestoredWorkerPreSpaceCtx extends RestoredWorkerPreSpaceInput {
  decision: boolean | null;
}

export interface RestoredWorkerAdmissionInput {
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

function decided<Ctx extends { decision: boolean | null }>(ctx: Ctx, admitted: boolean): Ctx {
  return { ...ctx, decision: admitted };
}

function readLazyInput<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export function applyManualQueryModeGate(
  ctx: RestoredWorkerPreSpaceCtx
): RestoredWorkerPreSpaceCtx {
  return !ctx.settleReplayProvisioning && ctx.queryMode === 'manual' ? decided(ctx, false) : ctx;
}

export function applyDaemonCleanupGate(ctx: RestoredWorkerPreSpaceCtx): RestoredWorkerPreSpaceCtx {
  return ctx.daemonCleaningUp ? decided(ctx, false) : ctx;
}

export function applyTaskGate(ctx: RestoredWorkerPreSpaceCtx): RestoredWorkerPreSpaceCtx {
  const task = readLazyInput(ctx.task);
  if (!task?.workflowRunId) return decided(ctx, false);
  return task.status === 'cancelled' || task.status === 'archived' ? decided(ctx, false) : ctx;
}

export function applyWorkflowRunGate(ctx: RestoredWorkerPreSpaceCtx): RestoredWorkerPreSpaceCtx {
  const workflowRun = readLazyInput(ctx.workflowRun);
  return workflowRun !== null && workflowRun.status !== 'cancelled' ? ctx : decided(ctx, false);
}

export function applyContinueGate(ctx: RestoredWorkerPreSpaceCtx): RestoredWorkerPreSpaceCtx {
  return decided(ctx, true);
}

const restoredWorkerPreSpaceAdmissionRun = decisionRun('restored-worker-pre-space-admission', [
  applyManualQueryModeGate,
  applyDaemonCleanupGate,
  applyTaskGate,
  applyWorkflowRunGate,
  applyContinueGate,
]);

export function decideRestoredWorkerPreSpaceAdmission(input: RestoredWorkerPreSpaceInput): boolean {
  return restoredWorkerPreSpaceAdmissionRun(input).decision ?? false;
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

export function applyExecutionGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  const execution = readLazyInput(ctx.execution);
  if (execution === null) return decided(ctx, false);
  if (execution.status === 'in_progress' || execution.status === 'blocked') return ctx;
  return readLazyInput(ctx.hasQueuedRetryableHookAction) ? ctx : decided(ctx, false);
}

export function applyAdmitGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  return decided(ctx, true);
}

const restoredWorkerAdmissionRun = decisionRun('restored-worker-start-admission', [
  applySessionStatusGate,
  applySpaceGate,
  applyPostApprovalGate,
  applyTerminalForSpawnGate,
  applyExecutionGate,
  applyAdmitGate,
]);

export function decideRestoredWorkerAdmission(input: RestoredWorkerAdmissionInput): boolean {
  return restoredWorkerAdmissionRun(input).decision ?? false;
}
