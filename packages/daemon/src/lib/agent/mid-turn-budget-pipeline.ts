import type { ContextInfo } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { MidTurnBudgetInterruptOptions, MidTurnQueueSeam } from './message-queue.ts';

export interface MidTurnInterruptReceipt {
  still_queued: string[];
  cancelled?: string[];
}

export interface MidTurnInterruptDeadline {
  promise: Promise<MidTurnInterruptReceipt | undefined>;
  timedOut: boolean;
  hardFailed: boolean;
  receipt?: MidTurnInterruptReceipt;
}

export interface MidTurnSurvivorsDisposition {
  toRequeue: string[];
  needsRestart: boolean;
}

export type MidTurnBudgetOutcome =
  | { action: 'skipped' }
  | { action: 'stood-down' }
  | { action: 'deferred' }
  | { action: 'completed' };

export type MidTurnBudgetPhase = 'interrupt' | 'late-receipt';

export interface MidTurnBudgetCtx {
  opts: MidTurnBudgetInterruptOptions;
  queue: MidTurnQueueSeam;
  phase: MidTurnBudgetPhase;
  lateReceipt: MidTurnInterruptReceipt | null;
  checkEligibility: (() => boolean) | undefined;
  refreshUsage: (() => Promise<ContextInfo | null>) | undefined;
  decideCompaction: ((info: ContextInfo) => boolean) | undefined;
  preArmed: boolean;
  info: ContextInfo | null;
  interrupt: MidTurnInterruptDeadline | null;
  survivors: MidTurnSurvivorsDisposition;
  removedPendingCompactions: number;
  windowBoundarySeq: number;
  restarted: boolean;
  outcome: MidTurnBudgetOutcome | null;
}

export type MidTurnBudgetPipelineInput = Omit<
  MidTurnBudgetCtx,
  | 'info'
  | 'interrupt'
  | 'survivors'
  | 'restarted'
  | 'outcome'
  | 'preArmed'
  | 'phase'
  | 'lateReceipt'
  | 'removedPendingCompactions'
  | 'windowBoundarySeq'
> & {
  preArmed?: boolean;
  phase?: MidTurnBudgetPhase;
  lateReceipt?: MidTurnInterruptReceipt | null;
};

function settled(ctx: MidTurnBudgetCtx): boolean {
  return ctx.outcome !== null;
}

function done(ctx: MidTurnBudgetCtx, outcome: MidTurnBudgetOutcome): MidTurnBudgetCtx {
  return { ...ctx, outcome };
}

function inLatePhase(ctx: MidTurnBudgetCtx): boolean {
  return ctx.phase === 'late-receipt';
}

function gateEligibilityStage(ctx: MidTurnBudgetCtx): MidTurnBudgetCtx {
  if (inLatePhase(ctx) || !ctx.checkEligibility) return ctx;
  return ctx.checkEligibility() ? ctx : done(ctx, { action: 'skipped' });
}

async function refreshUsageStage(ctx: MidTurnBudgetCtx): Promise<MidTurnBudgetCtx> {
  if (inLatePhase(ctx) || !ctx.refreshUsage || !ctx.decideCompaction) return ctx;
  const info = await ctx.refreshUsage();
  const next = { ...ctx, info };
  if (!info || !ctx.decideCompaction(info)) return done(next, { action: 'skipped' });
  return next;
}

function armInterruptStage(ctx: MidTurnBudgetCtx): MidTurnBudgetCtx {
  if (inLatePhase(ctx) || ctx.preArmed) return ctx;
  ctx.queue.armInterruptCycle(ctx.opts);
  return ctx;
}

async function awaitInterruptDeadlineStage(ctx: MidTurnBudgetCtx): Promise<MidTurnBudgetCtx> {
  if (inLatePhase(ctx)) return ctx;
  const interrupt = await ctx.queue.awaitInterruptDeadline(ctx.opts);
  const next = { ...ctx, interrupt };
  if (interrupt.hardFailed) return done(next, { action: 'deferred' });
  return next;
}

async function survivorsStage(ctx: MidTurnBudgetCtx): Promise<MidTurnBudgetCtx> {
  if (ctx.queue.standsDownFor(ctx.opts)) {
    ctx.opts.onResumeClear();
    return done(ctx, { action: 'stood-down' });
  }
  let removedPendingCompactions = ctx.removedPendingCompactions;
  let windowBoundarySeq = ctx.windowBoundarySeq;
  if (inLatePhase(ctx)) {
    const window = ctx.queue.openLateReceiptWindow(ctx.opts);
    removedPendingCompactions = window.removedPendingCompactions;
    windowBoundarySeq = window.boundarySeq;
  }
  if (ctx.interrupt?.timedOut) {
    return {
      ...ctx,
      removedPendingCompactions,
      windowBoundarySeq,
      survivors: { toRequeue: [], needsRestart: true },
    };
  }
  const receipt = inLatePhase(ctx)
    ? (ctx.lateReceipt ?? undefined)
    : (ctx.interrupt?.receipt ?? undefined);
  const survivors = await ctx.queue.processInterruptSurvivors(ctx.opts, receipt);
  return { ...ctx, removedPendingCompactions, windowBoundarySeq, survivors };
}

function requeueStage(ctx: MidTurnBudgetCtx): MidTurnBudgetCtx {
  if (ctx.queue.standsDownFor(ctx.opts)) {
    ctx.opts.onResumeClear();
    return done(ctx, { action: 'stood-down' });
  }
  ctx.queue.requeueInterruptSurvivors(ctx.opts, ctx.survivors.toRequeue);
  return ctx;
}

async function restartOrStandDownStage(ctx: MidTurnBudgetCtx): Promise<MidTurnBudgetCtx> {
  if (inLatePhase(ctx)) {
    if (
      !ctx.queue.standsDownFor(ctx.opts) &&
      ctx.queue.shouldEnqueueLateCompaction(ctx.removedPendingCompactions) &&
      !ctx.queue.boundaryCompletedSince(ctx.windowBoundarySeq) &&
      !ctx.queue.hasOutstandingInternalCompaction()
    ) {
      ctx.queue.enqueueMidTurnCompaction(ctx.opts, 'mid-turn-late');
    }
    return done(ctx, { action: 'completed' });
  }
  ctx.queue.registerLateReceipt(ctx.opts, ctx.interrupt);
  if (ctx.survivors.needsRestart) {
    await ctx.queue.finishSurvivorTeardownWithRestart(ctx.opts);
    return done({ ...ctx, restarted: true }, { action: 'completed' });
  }
  if (!ctx.queue.shouldSuppressPromptPhaseCompaction()) {
    ctx.queue.enqueueMidTurnCompaction(ctx.opts, 'mid-turn');
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
  .pipe(awaitInterruptDeadlineStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(survivorsStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(requeueStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(restartOrStandDownStage, 'ctx', 'ctx')
  .endAsync('ctx');

export async function runMidTurnBudgetPipeline(
  input: MidTurnBudgetPipelineInput
): Promise<MidTurnBudgetCtx> {
  return midTurnBudgetPipeline({
    ...input,
    preArmed: input.preArmed ?? false,
    phase: input.phase ?? 'interrupt',
    lateReceipt: input.lateReceipt ?? null,
    info: null,
    interrupt: null,
    survivors: { toRequeue: [], needsRestart: false },
    removedPendingCompactions: 0,
    windowBoundarySeq: 0,
    restarted: false,
    outcome: null,
  }) as Promise<MidTurnBudgetCtx>;
}
