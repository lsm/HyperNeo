import {
  isRateOrUsageLimited,
  isWorkflowRunSucceeded,
  isWorkflowRunWaiting,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { RunTickContext } from './space-runtime.ts';
import {
  continued,
  skipped,
  type RunTickCtx,
  type SpaceWorkflowRunTickDeps,
  type SpaceWorkflowRunTickOutcome,
  type TickResult,
} from './run-tick-contract.ts';

export function loadRunContext(ctx: RunTickCtx, next: (err: unknown, value?: RunTickCtx) => void) {
  const run = ctx.deps.getRun(ctx.runId);
  const deliver = (context: RunTickContext | null) => next(null, { ...ctx, run, context });
  if (
    run &&
    run.status !== 'cancelled' &&
    !isWorkflowRunSucceeded(run.status) &&
    !isWorkflowRunWaiting(run.status)
  ) {
    ctx.deps.loadRunContext(ctx.runId, run).then(deliver, (err: unknown) => next(err));
    return;
  }
  deliver(null);
}

export function haltIfRunMissing(ctx: RunTickCtx): TickResult {
  return ctx.run ? continued(ctx) : skipped('missing_run');
}

export function haltIfRunFinished(ctx: RunTickCtx): TickResult {
  if (!ctx.run || (ctx.run.status !== 'cancelled' && !isWorkflowRunSucceeded(ctx.run.status))) {
    return continued(ctx);
  }
  ctx.deps.clearAgentStuckStateForRun(ctx.runId);
  return { reason: { action: 'cleared_finished_run' } };
}

export async function routeWaitingRun(ctx: RunTickCtx): Promise<TickResult> {
  if (!ctx.run || !isWorkflowRunWaiting(ctx.run.status)) return continued(ctx);
  await ctx.deps.recoverBlockedRun(ctx.runId, ctx.run);
  return { reason: { action: 'recovered_waiting_run' } };
}

export function haltIfNoRunContext(ctx: RunTickCtx): TickResult {
  return ctx.context ? continued(ctx) : skipped('no_run_context');
}

export async function haltIfWorkflowInvalid(ctx: RunTickCtx): Promise<TickResult> {
  if (ctx.context!.meta.workflow.endNodeId) return continued(ctx);
  await ctx.deps.blockInvalidWorkflowRun(ctx.runId, ctx.context!.meta, ctx.context!.canonicalTask);
  return { reason: { action: 'blocked_invalid_workflow' } };
}

export function haltIfRateLimited(ctx: RunTickCtx): TickResult {
  return isRateOrUsageLimited(ctx.context!.canonicalTask.status)
    ? skipped('rate_or_usage_limited')
    : continued(ctx);
}

export function haltIfTaskStopped(ctx: RunTickCtx): TickResult {
  return ctx.context!.canonicalTask.status === 'stopped' ? skipped('task_stopped') : continued(ctx);
}

export function haltIfNoExecutions(ctx: RunTickCtx): TickResult {
  return ctx.context!.loadNodeExecutions().length > 0 ? continued(ctx) : skipped('no_executions');
}

export function pruneStaleNotifyDedupKeys(ctx: RunTickCtx): RunTickCtx {
  ctx.deps.pruneStaleNotifyDedupKeys(ctx.context!.canonicalTask);
  return ctx;
}

export async function haltIfBlockedExecutions(ctx: RunTickCtx): Promise<TickResult> {
  const context = ctx.context!;
  const blockedExecution = context.resolveRunIsComplete()
    ? undefined
    : context.loadNodeExecutions().find((execution) => execution.status === 'blocked');
  if (!blockedExecution) return continued(ctx);
  await ctx.deps.blockRunOnBlockedExecutions(
    ctx.runId,
    context.meta,
    context.canonicalTask,
    blockedExecution.result ?? 'One or more workflow agents are blocked'
  );
  return { reason: { action: 'blocked_on_blocked_executions' } };
}

export async function loadExecutionsAndSpace(ctx: RunTickCtx): Promise<RunTickCtx> {
  const context = ctx.context!;
  return {
    ...ctx,
    nodeExecutions: context.loadNodeExecutions(),
    runIsComplete: context.resolveRunIsComplete(),
    space: await ctx.deps.getSpace(context.meta.spaceId),
  };
}

export async function recoverStrandedExecutions(ctx: RunTickCtx): Promise<RunTickCtx> {
  const result = await ctx.deps.recoverStrandedExecutions(
    ctx.runId,
    ctx.run!,
    ctx.context!,
    ctx.nodeExecutions!,
    ctx.runIsComplete!,
    ctx.space ?? null
  );
  if (result.action === 'halted') return { ...ctx, recovery: undefined };
  return {
    ...ctx,
    recovery: {
      tam: result.tam,
      blockedByCrash: result.blockedByCrash,
      preTickPendingIds: result.preTickPendingIds,
    },
  };
}

export function haltIfStrandedRecoveryHalted(ctx: RunTickCtx): TickResult {
  return ctx.recovery ? continued(ctx) : { reason: { action: 'halted_stranded_recovery' } };
}

export async function settleIfComplete(ctx: RunTickCtx): Promise<TickResult> {
  const settled = await ctx.deps.settleIfComplete(
    ctx.runId,
    ctx.runIsComplete!,
    ctx.context!.meta,
    ctx.context!.canonicalTask
  );
  return settled ? { reason: { action: 'settled_run' } } : continued(ctx);
}

export async function haltIfSpaceInactive(ctx: RunTickCtx): Promise<TickResult> {
  const result = await ctx.deps.haltTickForInactiveSpace(ctx.runId, ctx.run!, ctx.context!);
  return result === 'halted' ? { reason: { action: 'halted_space_inactive' } } : continued(ctx);
}

export function promotePendingExecutionsWithLiveSessions(ctx: RunTickCtx): RunTickCtx {
  return {
    ...ctx,
    nodeExecutions: ctx.deps.promotePendingExecutionsWithLiveSessions(
      ctx.runId,
      ctx.recovery!.preTickPendingIds,
      ctx.recovery!.tam
    ),
  };
}

export async function ensureCanonicalTaskInProgress(ctx: RunTickCtx): Promise<TickResult> {
  const task = ctx.spawn?.canonicalTask ?? ctx.context!.canonicalTask;
  const active =
    ctx.spawned ||
    ctx.nodeExecutions?.some(
      (execution) => execution.status === 'in_progress' || execution.status === 'waiting_rebind'
    );
  const canonicalTask =
    active && (task.status === 'open' || task.status === 'blocked')
      ? await ctx.deps.ensureCanonicalTaskInProgress(ctx.context!.meta.spaceId, task)
      : task;
  const next = canonicalTask ? { ...ctx, context: { ...ctx.context!, canonicalTask } } : ctx;
  const availableTaskSlots = ctx.deps.getAvailableTaskSlots(ctx.space ?? null);
  return !active && next.context!.canonicalTask.status === 'open' && availableTaskSlots <= 0
    ? { reason: { action: 'halted_stranded_recovery' } }
    : continued(next);
}

export function admitSpawnExecution(ctx: RunTickCtx): RunTickCtx {
  return {
    ...ctx,
    spawn: ctx.deps.admitSpawnExecution(
      ctx.runId,
      ctx.context!.meta,
      ctx.context!.canonicalTask,
      ctx.nodeExecutions!,
      ctx.space ?? null
    ),
  };
}

export async function spawnPendingExecutions(ctx: RunTickCtx): Promise<RunTickCtx> {
  const spawn = ctx.spawn;
  if (!spawn || spawn.spawnAdmission.action !== 'spawn' || !ctx.space) return ctx;
  const spawned = await ctx.deps.spawnPendingExecutions(
    ctx.runId,
    spawn.canonicalTask,
    ctx.space,
    ctx.context!.meta,
    ctx.run!,
    spawn.pendingExecutions,
    ctx.recovery!.tam,
    ctx.recovery!.blockedByCrash
  );
  return { ...ctx, spawned };
}

export async function blockRunForSpawnFailure(ctx: RunTickCtx): Promise<RunTickCtx> {
  if (!ctx.spawned) return ctx;
  const blocked = await ctx.deps.blockRunForSpawnFailure(
    ctx.runId,
    ctx.context!.meta,
    ctx.spawn!.canonicalTask,
    ctx.spawned.permanentSpawnFailureReason,
    ctx.spawned.blockedByCrash
  );
  return { ...ctx, spawnFailureBlocked: blocked };
}

export function finalizeTick(_ctx: RunTickCtx): TickResult {
  return { reason: { action: 'ran_to_completion' } };
}

const runTickRun = (
  superpipe<{ spawnFailureBlocksRun: (ctx: RunTickCtx) => boolean }>({
    spawnFailureBlocksRun: (ctx: RunTickCtx): boolean => ctx.spawnFailureBlocked === true,
  })('space-workflow-run-tick') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadRunContext, ['ctx', 'next'], 'ctx')
  .pipe(haltIfRunMissing, 'ctx', 'result:tickOutcome')
  .pipe(haltIfRunFinished, 'ctx', 'result:tickOutcome')
  .pipe(routeWaitingRun, 'ctx', 'result:tickOutcome')
  .pipe(haltIfNoRunContext, 'ctx', 'result:tickOutcome')
  .pipe(haltIfWorkflowInvalid, 'ctx', 'result:tickOutcome')
  .pipe(haltIfRateLimited, 'ctx', 'result:tickOutcome')
  .pipe(haltIfTaskStopped, 'ctx', 'result:tickOutcome')
  .pipe(haltIfNoExecutions, 'ctx', 'result:tickOutcome')
  .pipe(pruneStaleNotifyDedupKeys, 'ctx', 'ctx')
  .pipe(haltIfBlockedExecutions, 'ctx', 'result:tickOutcome')
  .pipe(loadExecutionsAndSpace, 'ctx', 'ctx')
  .pipe(recoverStrandedExecutions, 'ctx', 'ctx')
  .pipe(haltIfStrandedRecoveryHalted, 'ctx', 'result:tickOutcome')
  .pipe(settleIfComplete, 'ctx', 'result:tickOutcome')
  .pipe(haltIfSpaceInactive, 'ctx', 'result:tickOutcome')
  .pipe(promotePendingExecutionsWithLiveSessions, 'ctx', 'ctx')
  .pipe(ensureCanonicalTaskInProgress, 'ctx', 'result:tickOutcome')
  .pipe(admitSpawnExecution, 'ctx', 'ctx')
  .pipe(spawnPendingExecutions, 'ctx', 'ctx')
  .pipe(blockRunForSpawnFailure, 'ctx', 'ctx')
  .pipe('!spawnFailureBlocksRun', 'ctx')
  .pipe(ensureCanonicalTaskInProgress, 'ctx', 'result:tickOutcome')
  .pipe(finalizeTick, 'ctx', 'result:tickOutcome')
  .endAsync('tickOutcome') as (input: RunTickCtx) => Promise<SpaceWorkflowRunTickOutcome>;

export async function runSpaceWorkflowRunTick(
  deps: SpaceWorkflowRunTickDeps,
  runId: string
): Promise<SpaceWorkflowRunTickOutcome> {
  const outcome = await runTickRun({ runId, deps });
  return outcome && typeof outcome === 'object' && 'action' in outcome
    ? outcome
    : { action: 'blocked_for_spawn_failure' };
}
