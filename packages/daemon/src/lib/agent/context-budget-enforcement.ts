import type { ContextInfo } from '@hyperneo/shared';
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
