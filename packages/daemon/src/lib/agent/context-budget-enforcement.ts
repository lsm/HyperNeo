import type { ContextInfo, ModelInfo, Session } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Logger } from '../logger.ts';
import {
  type ContextBudgetDecision,
  contextBudgetThreshold,
  decideContextBudgetCompaction,
} from './context-budget-decision.ts';
import type { ContextTracker } from './context-tracker.ts';
import type { MessageQueue } from './message-queue.ts';
import type { ProcessingStateManager } from './processing-state-manager.ts';
import { NATIVE_CONTEXT_WINDOW_PROVIDER_IDS } from './query-options-builder.js';

export interface ContextBudgetEnforcementCtx {
  sessionId: string;
  providerId: string | undefined;
  reason: 'event-tick' | 'turn-end' | 'compact-boundary' | 'model-switch';
  contextInfo: ContextInfo;
  fallbackContextWindow: number | undefined;
  clearedDeadCompaction: boolean;
  limitRecoveryPending: boolean;
  contextTracker: ContextTracker;
  messageQueue: MessageQueue;
  stateManager: ProcessingStateManager;
  logger: Logger;
  onCompactionAbandoned?: () => void;
  budgetKey: number;
  decision: ContextBudgetDecision | null;
  compactionEnqueued: boolean;
}

export type ContextBudgetEnforcementInput = Omit<
  ContextBudgetEnforcementCtx,
  'budgetKey' | 'decision' | 'compactionEnqueued'
>;

export function resolveBudgetThresholds(
  ctx: ContextBudgetEnforcementCtx
): ContextBudgetEnforcementCtx {
  const effectiveWindow =
    ctx.contextInfo.totalCapacity > 0 ? ctx.contextInfo.totalCapacity : ctx.fallbackContextWindow;
  return {
    ...ctx,
    budgetKey: contextBudgetThreshold(effectiveWindow ?? 0, ctx.contextInfo.autoCompactPercent),
  };
}

export function runContextBudgetDecision(
  ctx: ContextBudgetEnforcementCtx
): ContextBudgetEnforcementCtx {
  const effectiveWindow =
    ctx.contextInfo.totalCapacity > 0 ? ctx.contextInfo.totalCapacity : ctx.fallbackContextWindow;
  return {
    ...ctx,
    decision: decideContextBudgetCompaction({
      totalUsed: ctx.contextInfo.totalUsed,
      configuredWindow: effectiveWindow,
      autoCompactPercent: ctx.contextInfo.autoCompactPercent,
      sdkAutoCompactEnabled: ctx.contextInfo.isAutoCompactEnabled,
      sdkAutoCompactThreshold: ctx.contextInfo.sdkAutoCompactThreshold,
      cooldownActive: ctx.contextTracker.isCoolingDown(ctx.budgetKey),
      compactingActive: ctx.stateManager.getIsCompacting(),
    }),
  };
}

export function enqueueBudgetCompaction(
  ctx: ContextBudgetEnforcementCtx
): ContextBudgetEnforcementCtx {
  ctx.contextTracker.markCompactionTriggered(ctx.budgetKey);
  ctx.logger.info(
    `Daemon context-budget compaction for session ${ctx.sessionId} ` +
      `(provider=${ctx.providerId}, reason=${ctx.decision?.reason}, ` +
      `${ctx.contextInfo.totalUsed} >= ${ctx.budgetKey} tokens)`
  );
  void ctx.messageQueue
    .enqueue('/compact', true, { durable: true, prepend: true })
    .catch((error) => {
      if (ctx.messageQueue.hasOutstandingInternalCompaction()) {
        return;
      }
      ctx.logger.warn(`compaction enqueue failed for session ${ctx.sessionId}:`, error);
      ctx.contextTracker.clearCompactionCooldown();
      ctx.onCompactionAbandoned?.();
    });
  return { ...ctx, compactionEnqueued: true };
}

const runEnforceContextBudget = (
  superpipe({
    providerSkipsEnforcement: (ctx: ContextBudgetEnforcementCtx) =>
      !ctx.providerId ||
      ctx.providerId === 'acp' ||
      NATIVE_CONTEXT_WINDOW_PROVIDER_IDS.includes(ctx.providerId),
    limitRecoveryOwnsTurn: (ctx: ContextBudgetEnforcementCtx) =>
      ctx.stateManager.getState().status === 'rate_limit_cooldown' || ctx.limitRecoveryPending,
    deadCompactionCleared: (ctx: ContextBudgetEnforcementCtx) => ctx.clearedDeadCompaction,
    userQuestionOutstanding: (ctx: ContextBudgetEnforcementCtx) =>
      ctx.stateManager.getState().status === 'waiting_for_input',
    queueShutDown: (ctx: ContextBudgetEnforcementCtx) =>
      !ctx.messageQueue.isRunning() && ctx.reason !== 'model-switch',
    compactionOutstanding: (ctx: ContextBudgetEnforcementCtx) =>
      ctx.messageQueue.hasOutstandingInternalCompaction(),
    budgetRequiresNoCompaction: (ctx: ContextBudgetEnforcementCtx) =>
      ctx.decision?.action !== 'compact',
  })('enforce-context-budget') as PipelineAPI
)
  .input(['ctx'])
  .pipe('!providerSkipsEnforcement', 'ctx')
  .pipe('!limitRecoveryOwnsTurn', 'ctx')
  .pipe('!userQuestionOutstanding', 'ctx')
  .pipe('!queueShutDown', 'ctx')
  .pipe('!deadCompactionCleared', 'ctx')
  .pipe(resolveBudgetThresholds, 'ctx', 'ctx')
  .pipe('!compactionOutstanding', 'ctx')
  .pipe(runContextBudgetDecision, 'ctx', 'ctx')
  .pipe('!budgetRequiresNoCompaction', 'ctx')
  .pipe(enqueueBudgetCompaction, 'ctx', 'ctx')
  .end('ctx') as (ctx: ContextBudgetEnforcementCtx) => ContextBudgetEnforcementCtx;

export function enforceContextBudget(
  input: ContextBudgetEnforcementInput
): ContextBudgetEnforcementCtx {
  return runEnforceContextBudget({
    ...input,
    budgetKey: 0,
    decision: null,
    compactionEnqueued: false,
  });
}

export interface ContextBudgetReevaluationCtx {
  session: Session;
  trackerInfo: ContextInfo;
  resolveModelInfo: () => Promise<ModelInfo | null>;
  limitRecoveryPending: boolean;
  contextTracker: ContextTracker;
  messageQueue: MessageQueue;
  stateManager: ProcessingStateManager;
  logger: Logger;
  resumePendingWork: () => void;
  clearPendingResume: () => void;
  fenceModel: string;
  fenceProvider: string | undefined;
  queueClearEpochAtStart: number;
  userInterruptEpochAtStart: number;
  supersededQueued: boolean;
  modelInfo: ModelInfo | null;
  compactionEnqueued: boolean;
}

export type ContextBudgetReevaluationInput = Omit<
  ContextBudgetReevaluationCtx,
  | 'fenceModel'
  | 'fenceProvider'
  | 'queueClearEpochAtStart'
  | 'userInterruptEpochAtStart'
  | 'supersededQueued'
  | 'modelInfo'
  | 'compactionEnqueued'
>;

export function revokeSupersededCompactions(
  ctx: ContextBudgetReevaluationCtx
): ContextBudgetReevaluationCtx {
  const revoked = ctx.messageQueue.removePendingInternalCompactions();
  if (revoked > 0) {
    ctx.contextTracker.clearCompactionCooldown();
  }
  return { ...ctx, supersededQueued: revoked > 0 };
}

export async function resolveReevaluationModelInfo(
  ctx: ContextBudgetReevaluationCtx
): Promise<ContextBudgetReevaluationCtx> {
  return { ...ctx, modelInfo: await ctx.resolveModelInfo() };
}

export function runReevaluationEnforcement(
  ctx: ContextBudgetReevaluationCtx
): ContextBudgetReevaluationCtx {
  const modelInfo = ctx.modelInfo;
  const trackerInfo = ctx.contextTracker.getContextInfo();
  if (!trackerInfo || trackerInfo.totalUsed <= 0) {
    return ctx;
  }
  const contextInfo: ContextInfo = {
    ...trackerInfo,
    totalCapacity:
      modelInfo?.contextWindow && modelInfo.contextWindow > 0
        ? modelInfo.contextWindow
        : trackerInfo.totalCapacity,
    autoCompactPercent: modelInfo ? modelInfo.autoCompactPercent : trackerInfo.autoCompactPercent,
  };
  const outcome = enforceContextBudget({
    sessionId: ctx.session.id,
    providerId: ctx.session.config.provider,
    reason: 'model-switch',
    contextInfo,
    fallbackContextWindow: modelInfo?.contextWindow,
    clearedDeadCompaction: false,
    limitRecoveryPending: ctx.limitRecoveryPending,
    contextTracker: ctx.contextTracker,
    messageQueue: ctx.messageQueue,
    stateManager: ctx.stateManager,
    logger: ctx.logger,
    onCompactionAbandoned: ctx.clearPendingResume,
  });
  return { ...ctx, compactionEnqueued: outcome.compactionEnqueued };
}

export function settlePendingResumeAfterReevaluation(
  ctx: ContextBudgetReevaluationCtx
): ContextBudgetReevaluationCtx {
  if (ctx.supersededQueued) {
    ctx.resumePendingWork();
  } else {
    ctx.clearPendingResume();
  }
  return ctx;
}

const runReevaluateContextBudget = (
  superpipe({
    modelFenceChanged: (ctx: ContextBudgetReevaluationCtx) =>
      ctx.session.config.model !== ctx.fenceModel ||
      ctx.session.config.provider !== ctx.fenceProvider,
    modelInfoUnresolved: (ctx: ContextBudgetReevaluationCtx) => ctx.modelInfo === null,
    queueClearedDuringEvaluation: (ctx: ContextBudgetReevaluationCtx) =>
      ctx.messageQueue.getClearEpoch() !== ctx.queueClearEpochAtStart ||
      ctx.messageQueue.getUserInterruptEpoch() !== ctx.userInterruptEpochAtStart,
    resumeSettledElsewhere: (ctx: ContextBudgetReevaluationCtx) =>
      ctx.compactionEnqueued || ctx.messageQueue.hasOutstandingInternalCompaction(),
  })('reevaluate-context-budget') as PipelineAPI
)
  .input(['ctx'])
  .pipe(resolveReevaluationModelInfo, 'ctx', 'ctx')
  .pipe('!modelFenceChanged', 'ctx')
  .pipe('!modelInfoUnresolved', 'ctx')
  .pipe('!queueClearedDuringEvaluation', 'ctx')
  .pipe(revokeSupersededCompactions, 'ctx', 'ctx')
  .pipe(runReevaluationEnforcement, 'ctx', 'ctx')
  .pipe('!resumeSettledElsewhere', 'ctx')
  .pipe(settlePendingResumeAfterReevaluation, 'ctx', 'ctx')
  .endAsync('ctx');

export function runContextBudgetReevaluation(
  input: ContextBudgetReevaluationInput
): Promise<ContextBudgetReevaluationCtx> {
  return runReevaluateContextBudget({
    ...input,
    fenceModel: input.session.config.model,
    fenceProvider: input.session.config.provider,
    queueClearEpochAtStart: input.messageQueue.getClearEpoch(),
    userInterruptEpochAtStart: input.messageQueue.getUserInterruptEpoch(),
    supersededQueued: false,
    modelInfo: null,
    compactionEnqueued: false,
  }) as Promise<ContextBudgetReevaluationCtx>;
}
