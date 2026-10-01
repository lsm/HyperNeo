import { AUTO_COMPACT_PERCENT_MAX, resolveAutoCompactPercent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI, type Result } from 'superpipe';

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

export interface ContextBudgetInput {
  totalUsed: number;
  configuredWindow: number | undefined;
  autoCompactPercent: number | undefined;
  sdkAutoCompactEnabled: boolean | undefined;
  sdkAutoCompactThreshold: number | undefined;
  cooldownActive: boolean;
  compactingActive: boolean;
}

export type ContextBudgetGateResult = Result<ContextBudgetInput, ContextBudgetDecision>;

function hasValidWindow(configuredWindow: number | undefined): configuredWindow is number {
  return (
    typeof configuredWindow === 'number' &&
    Number.isFinite(configuredWindow) &&
    configuredWindow > 0
  );
}

function concluded(reason: ContextBudgetNoneReason): ContextBudgetGateResult {
  return { reason: { action: 'none', reason } };
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

export function gateNoWindow(input: ContextBudgetInput): ContextBudgetGateResult {
  if (!hasValidWindow(input.configuredWindow)) return concluded('no_window');
  return { value: input };
}

export function gatePercentDisabled(input: ContextBudgetInput): ContextBudgetGateResult {
  if (resolveAutoCompactPercent(input.autoCompactPercent) >= AUTO_COMPACT_PERCENT_MAX) {
    return concluded('percent_disabled');
  }
  return { value: input };
}

export function gateCooldown(input: ContextBudgetInput): ContextBudgetGateResult {
  return input.cooldownActive ? concluded('cooldown_active') : { value: input };
}

export function gateCompacting(input: ContextBudgetInput): ContextBudgetGateResult {
  return input.compactingActive ? concluded('compaction_in_progress') : { value: input };
}

export function gateBelowThreshold(input: ContextBudgetInput): ContextBudgetGateResult {
  if (!hasValidWindow(input.configuredWindow)) return { value: input };
  const threshold = contextBudgetThreshold(input.configuredWindow, input.autoCompactPercent);
  return input.totalUsed < threshold ? concluded('below_threshold') : { value: input };
}

export function gateCompactFinal(input: ContextBudgetInput): { value: ContextBudgetDecision } {
  const reason: ContextBudgetCompactReason =
    input.sdkAutoCompactEnabled === false
      ? 'over_threshold_sdk_disabled'
      : typeof input.sdkAutoCompactThreshold === 'number' && input.sdkAutoCompactThreshold > 0
        ? input.totalUsed >= input.sdkAutoCompactThreshold
          ? 'over_threshold_sdk_missed'
          : 'over_threshold_sdk_later'
        : 'over_threshold_sdk_unknown';
  return { value: { action: 'compact', reason } };
}

const runDecideContextBudgetAction = (superpipe({})('decide-context-budget-action') as PipelineAPI)
  .input('input')
  .pipe(gateNoWindow, 'input', 'result:budget')
  .pipe(gatePercentDisabled, 'budget', 'result:budget')
  .pipe(gateCooldown, 'budget', 'result:budget')
  .pipe(gateCompacting, 'budget', 'result:budget')
  .pipe(gateBelowThreshold, 'budget', 'result:budget')
  .pipe(gateCompactFinal, 'budget', 'result:budget')
  .end('budget') as (input: ContextBudgetInput) => ContextBudgetDecision;

export function decideContextBudgetCompaction(input: ContextBudgetInput): ContextBudgetDecision {
  return runDecideContextBudgetAction({ ...input });
}
