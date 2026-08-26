import { AUTO_COMPACT_PERCENT_MAX, resolveAutoCompactPercent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type ContextBudgetNoneReason =
  | 'no_window'
  | 'percent_disabled'
  | 'cooldown_active'
  | 'compaction_in_progress'
  | 'below_threshold';

export type ContextBudgetCompactReason =
  | 'over_threshold_sdk_disabled'
  | 'over_threshold_sdk_unknown'
  | 'over_threshold_sdk_later'
  | 'over_threshold_sdk_missed';

export type ContextBudgetDecision =
  | { action: 'none'; reason: ContextBudgetNoneReason }
  | { action: 'compact'; reason: ContextBudgetCompactReason };

export interface ContextBudgetCtx {
  totalUsed: number;
  configuredWindow: number | undefined;
  autoCompactPercent: number | undefined;
  sdkAutoCompactEnabled: boolean | undefined;
  sdkAutoCompactThreshold: number | undefined;
  cooldownActive: boolean;
  compactingActive: boolean;
  decision: ContextBudgetDecision | null;
}

export type ContextBudgetInput = Omit<ContextBudgetCtx, 'decision'>;

function decided(ctx: ContextBudgetCtx, decision: ContextBudgetDecision): ContextBudgetCtx {
  return { ...ctx, decision };
}

function hasValidWindow(configuredWindow: number | undefined): configuredWindow is number {
  return (
    typeof configuredWindow === 'number' &&
    Number.isFinite(configuredWindow) &&
    configuredWindow > 0
  );
}

export function contextBudgetThreshold(
  configuredWindow: number,
  autoCompactPercent: number | undefined
): number {
  return Math.floor((configuredWindow * resolveAutoCompactPercent(autoCompactPercent)) / 100);
}

export function scaledAutoCompactWindow(
  configuredWindow: number | null | undefined,
  rawPercent?: number | null
): number | undefined {
  if (
    typeof configuredWindow !== 'number' ||
    !Number.isFinite(configuredWindow) ||
    configuredWindow <= 0
  ) {
    return undefined;
  }
  return contextBudgetThreshold(configuredWindow, rawPercent ?? undefined);
}

export function gateNoWindow(ctx: ContextBudgetCtx): ContextBudgetCtx {
  if (!hasValidWindow(ctx.configuredWindow)) {
    return decided(ctx, { action: 'none', reason: 'no_window' });
  }
  return ctx;
}

export function gatePercentDisabled(ctx: ContextBudgetCtx): ContextBudgetCtx {
  if (resolveAutoCompactPercent(ctx.autoCompactPercent) >= AUTO_COMPACT_PERCENT_MAX) {
    return decided(ctx, { action: 'none', reason: 'percent_disabled' });
  }
  return ctx;
}

export function gateCooldown(ctx: ContextBudgetCtx): ContextBudgetCtx {
  return ctx.cooldownActive ? decided(ctx, { action: 'none', reason: 'cooldown_active' }) : ctx;
}

export function gateCompacting(ctx: ContextBudgetCtx): ContextBudgetCtx {
  return ctx.compactingActive
    ? decided(ctx, { action: 'none', reason: 'compaction_in_progress' })
    : ctx;
}

export function gateBelowThreshold(ctx: ContextBudgetCtx): ContextBudgetCtx {
  if (!hasValidWindow(ctx.configuredWindow)) return ctx;
  const threshold = contextBudgetThreshold(ctx.configuredWindow, ctx.autoCompactPercent);
  if (ctx.totalUsed < threshold) {
    return decided(ctx, { action: 'none', reason: 'below_threshold' });
  }
  return ctx;
}

export function gateCompactFinal(ctx: ContextBudgetCtx): ContextBudgetCtx {
  const reason: ContextBudgetCompactReason =
    ctx.sdkAutoCompactEnabled === false
      ? 'over_threshold_sdk_disabled'
      : typeof ctx.sdkAutoCompactThreshold === 'number' && ctx.sdkAutoCompactThreshold > 0
        ? ctx.totalUsed >= ctx.sdkAutoCompactThreshold
          ? 'over_threshold_sdk_missed'
          : 'over_threshold_sdk_later'
        : 'over_threshold_sdk_unknown';
  return decided(ctx, { action: 'compact', reason });
}

const decideContextBudgetAction = (
  superpipe<{ hasDecision: (ctx: ContextBudgetCtx) => boolean }>({
    hasDecision: (ctx: ContextBudgetCtx): boolean => ctx.decision !== null,
  })('decide-context-budget-action') as PipelineAPI
)
  .input(['ctx'])
  .pipe(gateNoWindow, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(gatePercentDisabled, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(gateCooldown, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(gateCompacting, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(gateBelowThreshold, 'ctx', 'ctx')
  .pipe('!hasDecision', 'ctx')
  .pipe(gateCompactFinal, 'ctx', 'ctx')
  .end('ctx');

export function decideContextBudgetCompaction(input: ContextBudgetInput): ContextBudgetDecision {
  const ctx = decideContextBudgetAction({ ...input, decision: null });
  return ctx.decision ?? { action: 'none', reason: 'below_threshold' };
}
