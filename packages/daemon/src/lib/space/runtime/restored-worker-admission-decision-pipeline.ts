import type { NodeExecution, Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
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
  return readLazyInput(ctx.daemonCleaningUp) ? decided(ctx, false) : ctx;
}

export function applyTaskGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  const task = readLazyInput(ctx.task);
  if (!task?.workflowRunId) return decided(ctx, false);
  return task.status === 'cancelled' || task.status === 'archived' ? decided(ctx, false) : ctx;
}

export function applyWorkflowRunGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  const workflowRun = readLazyInput(ctx.workflowRun);
  return workflowRun !== null && workflowRun.status !== 'cancelled' ? ctx : decided(ctx, false);
}

export async function applySpaceLookupGate(
  ctx: RestoredWorkerAdmissionCtx
): Promise<RestoredWorkerAdmissionCtx> {
  const space = await ctx.fetchSpace();
  return space !== null && !space.stopped && !space.paused && space.status !== 'archived'
    ? ctx
    : decided(ctx, false);
}

export function applySessionStatusGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionCtx {
  const sessionStatus = readLazyInput(ctx.sessionStatus);
  return sessionStatus === 'archived' || sessionStatus === 'ended' ? decided(ctx, false) : ctx;
}

export function applyPostApprovalGate(ctx: RestoredWorkerAdmissionCtx): RestoredWorkerAdmissionCtx {
  const task = readLazyInput(ctx.task);
  return ctx.sessionId.includes(':post-approval:')
    ? decided(ctx, task?.status === 'approved')
    : ctx;
}

export function applyTerminalForSpawnGate(
  ctx: RestoredWorkerAdmissionCtx
): RestoredWorkerAdmissionCtx {
  const task = readLazyInput(ctx.task);
  const workflowRun = readLazyInput(ctx.workflowRun);
  return task !== null &&
    (isCanonicalTaskTerminalForSpawn(task.status) || workflowRun?.status === 'done')
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

type AdmissionGate = (
  ctx: RestoredWorkerAdmissionCtx
) => RestoredWorkerAdmissionCtx | Promise<RestoredWorkerAdmissionCtx>;

function admissionRun(
  name: string,
  gates: ReadonlyArray<AdmissionGate>
): (input: Omit<RestoredWorkerAdmissionCtx, 'decision'>) => Promise<RestoredWorkerAdmissionCtx> {
  let pipeline = (
    superpipe<{ hasDecided: (ctx: RestoredWorkerAdmissionCtx) => boolean }>({
      hasDecided: (ctx: RestoredWorkerAdmissionCtx): boolean => ctx.decision !== null,
    })(name) as PipelineAPI
  ).input(['ctx']);
  for (const gate of gates) {
    pipeline = pipeline.pipe(gate, 'ctx', 'ctx').pipe('!hasDecided', 'ctx');
  }
  const run = pipeline.endAsync('ctx');
  return async (input) => (await run({ ...input, decision: null })) as RestoredWorkerAdmissionCtx;
}

const restoredWorkerAdmissionRun = admissionRun('restored-worker-start-admission', [
  applyManualQueryModeGate,
  applyDaemonCleanupGate,
  applyTaskGate,
  applyWorkflowRunGate,
  applySpaceLookupGate,
  applySessionStatusGate,
  applyPostApprovalGate,
  applyTerminalForSpawnGate,
  applyExecutionGate,
  applyAdmitGate,
]);

export async function decideRestoredWorkerAdmission(
  input: RestoredWorkerAdmissionInput
): Promise<boolean> {
  const ctx = await restoredWorkerAdmissionRun(input);
  return ctx.decision ?? false;
}
