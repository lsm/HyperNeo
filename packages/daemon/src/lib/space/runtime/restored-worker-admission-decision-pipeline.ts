import type { NodeExecution, Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import superpipe, { type PipelineAPI, type Result } from 'superpipe';
import { isCanonicalTaskTerminalForSpawn } from './run-spawn-decisions.ts';

export interface RestoredWorkerAdmissionInput {
  settleReplayProvisioning: boolean;
  queryMode: 'immediate' | 'manual' | undefined;
  daemonCleaningUp: boolean | (() => boolean);
  task: SpaceTask | null | (() => SpaceTask | null);
  workflowRun: SpaceWorkflowRun | null | (() => SpaceWorkflowRun | null);
  fetchSpace: () => Promise<Space | null>;
  sessionId: string;
  sessionStatus: string | (() => string);
  execution: NodeExecution | null | (() => NodeExecution | null);
  hasQueuedRetryableHookAction: boolean | (() => boolean);
}

export type RestoredWorkerAdmissionCtx = RestoredWorkerAdmissionInput;
type RestoredWorkerAdmissionResult = Result<RestoredWorkerAdmissionCtx, boolean>;

function decided(admitted: boolean): RestoredWorkerAdmissionResult {
  return { reason: admitted };
}

function continued(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionResult {
  return { value: ctx };
}

function readLazyInput<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export function applyManualQueryModeGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionResult {
  return !ctx.settleReplayProvisioning && ctx.queryMode === 'manual'
    ? decided(false)
    : continued(ctx);
}

export function applyDaemonCleanupGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionResult {
  return readLazyInput(ctx.daemonCleaningUp) ? decided(false) : continued(ctx);
}

export function applyTaskGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionResult {
  const task = readLazyInput(ctx.task);
  if (!task?.workflowRunId) return decided(false);
  return task.status === 'cancelled' || task.status === 'archived'
    ? decided(false)
    : continued(ctx);
}

export function applyWorkflowRunGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionResult {
  const workflowRun = readLazyInput(ctx.workflowRun);
  return workflowRun !== null && workflowRun.status !== 'cancelled'
    ? continued(ctx)
    : decided(false);
}

export async function applySpaceLookupGate(
  ctx: RestoredWorkerAdmissionCtx
): Promise<RestoredWorkerAdmissionResult> {
  const space = await ctx.fetchSpace();
  return space !== null && !space.stopped && !space.paused && space.status !== 'archived'
    ? continued(ctx)
    : decided(false);
}

export function applySessionStatusGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionResult {
  const sessionStatus = readLazyInput(ctx.sessionStatus);
  return sessionStatus === 'archived' || sessionStatus === 'ended'
    ? decided(false)
    : continued(ctx);
}

export function applyPostApprovalGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionResult {
  const task = readLazyInput(ctx.task);
  const isPostApprovalTarget =
    ctx.sessionId.includes(':post-approval:') || task?.postApprovalSessionId === ctx.sessionId;
  return isPostApprovalTarget ? decided(task?.status === 'approved') : continued(ctx);
}

export function applyTerminalForSpawnGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionResult {
  const task = readLazyInput(ctx.task);
  const workflowRun = readLazyInput(ctx.workflowRun);
  return task !== null &&
    (isCanonicalTaskTerminalForSpawn(task.status) || workflowRun?.status === 'done')
    ? decided(false)
    : continued(ctx);
}

export function applyExecutionGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionResult {
  const execution = readLazyInput(ctx.execution);
  if (execution === null) return decided(false);
  if (execution.status === 'in_progress' || execution.status === 'blocked') return continued(ctx);
  return readLazyInput(ctx.hasQueuedRetryableHookAction) ? continued(ctx) : decided(false);
}

export function applyAdmitGate(_ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionResult {
  return decided(true);
}

const restoredWorkerAdmissionRun = (superpipe()('restored-worker-start-admission') as PipelineAPI)
  .input(['ctx'])
  .pipe(applyManualQueryModeGate, 'ctx', 'result:decision')
  .pipe(applyDaemonCleanupGate, 'ctx', 'result:decision')
  .pipe(applyTaskGate, 'ctx', 'result:decision')
  .pipe(applyWorkflowRunGate, 'ctx', 'result:decision')
  .pipe(applySpaceLookupGate, 'ctx', 'result:decision')
  .pipe(applySessionStatusGate, 'ctx', 'result:decision')
  .pipe(applyPostApprovalGate, 'ctx', 'result:decision')
  .pipe(applyTerminalForSpawnGate, 'ctx', 'result:decision')
  .pipe(applyExecutionGate, 'ctx', 'result:decision')
  .pipe(applyAdmitGate, 'ctx', 'result:decision')
  .endAsync('decision');

export async function decideRestoredWorkerAdmission(
  input: RestoredWorkerAdmissionInput
): Promise<boolean> {
  return (await restoredWorkerAdmissionRun(input)) as boolean;
}
