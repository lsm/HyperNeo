import type { ContextInfo } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { MidTurnBudgetInterruptOptions, MidTurnQueueSeam } from './message-queue.ts';

export type MidTurnBudgetPhase = 'interrupt' | 'late-receipt';

export type MidTurnBudgetOutcome =
  | { action: 'skipped' }
  | { action: 'stood-down' }
  | { action: 'deferred' }
  | { action: 'completed' };

export interface MidTurnBudgetCtx {
  opts: MidTurnBudgetInterruptOptions;
  queue: MidTurnQueueSeam;
  phase: MidTurnBudgetPhase;
  lateReceipt: { still_queued: string[] } | null;
  preArmed: boolean;
  checkEligibility: (() => boolean) | undefined;
  refreshUsage: (() => Promise<ContextInfo | null>) | undefined;
  decideCompaction: ((info: ContextInfo) => boolean) | undefined;
  info: ContextInfo | null;
  interrupt: {
    promise: Promise<{ still_queued: string[] } | undefined>;
    timedOut: boolean;
    hardFailed: boolean;
    receipt?: { still_queued: string[] };
  } | null;
  removedPendingCompactions: number;
  restarted: boolean;
  outcome: MidTurnBudgetOutcome | null;
}

export type MidTurnBudgetPipelineInput = Omit<
  MidTurnBudgetCtx,
  'info' | 'interrupt' | 'outcome' | 'removedPendingCompactions' | 'restarted' | 'preArmed'
> & { preArmed?: boolean };

function settled(ctx: MidTurnBudgetCtx): boolean {
  return ctx.outcome !== null;
}

function done(ctx: MidTurnBudgetCtx, outcome: MidTurnBudgetOutcome): MidTurnBudgetCtx {
  return { ...ctx, outcome };
}

function inLatePhase(ctx: MidTurnBudgetCtx): boolean {
  return ctx.phase === 'late-receipt';
}

export function gateEligibilityStage(ctx: MidTurnBudgetCtx): MidTurnBudgetCtx {
  if (inLatePhase(ctx) || !ctx.checkEligibility) return ctx;
  return ctx.checkEligibility() ? ctx : done(ctx, { action: 'skipped' });
}

export async function refreshUsageStage(ctx: MidTurnBudgetCtx): Promise<MidTurnBudgetCtx> {
  if (inLatePhase(ctx) || !ctx.refreshUsage || !ctx.decideCompaction) return ctx;
  const info = await ctx.refreshUsage();
  const next = { ...ctx, info };
  if (!info || !ctx.decideCompaction(info)) return done(next, { action: 'skipped' });
  return next;
}

export function armInterruptStage(ctx: MidTurnBudgetCtx): MidTurnBudgetCtx {
  if (inLatePhase(ctx) || ctx.preArmed) return ctx;
  ctx.queue.armInterruptCycle(ctx.opts);
  return ctx;
}

export async function awaitInterruptStage(ctx: MidTurnBudgetCtx): Promise<MidTurnBudgetCtx> {
  if (inLatePhase(ctx)) return ctx;
  const interrupt = await ctx.queue.awaitInterruptDeadline(ctx.opts);
  const next = { ...ctx, interrupt };
  if (interrupt.hardFailed) return done(next, { action: 'deferred' });
  return next;
}

export function fenceContinuationStage(ctx: MidTurnBudgetCtx): MidTurnBudgetCtx {
  if (ctx.queue.standsDownFor(ctx.opts)) {
    ctx.opts.onResumeClear();
    return done(ctx, { action: 'stood-down' });
  }
  return ctx;
}

export async function survivorsStage(ctx: MidTurnBudgetCtx): Promise<MidTurnBudgetCtx> {
  const receipt = inLatePhase(ctx)
    ? (ctx.lateReceipt ?? undefined)
    : (ctx.interrupt?.receipt ?? undefined);
  if (inLatePhase(ctx)) {
    ctx.queue.openLateReceiptWindow(ctx.opts);
  }
  const allowRestart = !inLatePhase(ctx);
  const restarted = await ctx.queue.processInterruptSurvivorReceipt(
    ctx.opts,
    receipt,
    allowRestart
  );
  return { ...ctx, restarted };
}

export function compactionStage(ctx: MidTurnBudgetCtx): MidTurnBudgetCtx {
  if (inLatePhase(ctx)) {
    if (
      !ctx.queue.standsDownFor(ctx.opts) &&
      ctx.queue.shouldEnqueueLateCompaction() &&
      !ctx.queue.hasOutstandingInternalCompaction()
    ) {
      ctx.queue.enqueueMidTurnCompaction(ctx.opts, 'mid-turn-late');
    }
    return ctx;
  }
  const interrupt = ctx.interrupt;
  if (interrupt?.timedOut || interrupt?.hardFailed) {
    return ctx;
  }
  if (!ctx.restarted && !ctx.queue.standsDownFor(ctx.opts)) {
    ctx.queue.enqueueMidTurnCompaction(ctx.opts, 'mid-turn');
  }
  return ctx;
}

export function lateContinuationStage(ctx: MidTurnBudgetCtx): MidTurnBudgetCtx {
  if (!inLatePhase(ctx) && ctx.interrupt) {
    ctx.queue.registerLateReceipt(ctx.opts, ctx.interrupt);
  }
  return done(ctx, { action: 'completed' });
}

const midTurnBudgetPipeline = (superpipe({ settled })('mid-turn-budget-interrupt') as PipelineAPI)
  .input(['ctx'])
  .pipe(gateEligibilityStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(refreshUsageStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(armInterruptStage, 'ctx', 'ctx')
  .pipe(awaitInterruptStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(fenceContinuationStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(survivorsStage, 'ctx', 'ctx')
  .pipe(compactionStage, 'ctx', 'ctx')
  .pipe(lateContinuationStage, 'ctx', 'ctx')
  .endAsync('ctx');

export async function runMidTurnBudgetPipeline(
  input: MidTurnBudgetPipelineInput
): Promise<MidTurnBudgetCtx> {
  return midTurnBudgetPipeline({
    ...input,
    preArmed: input.preArmed ?? false,
    info: null,
    interrupt: null,
    removedPendingCompactions: 0,
    restarted: false,
    outcome: null,
  }) as Promise<MidTurnBudgetCtx>;
}
