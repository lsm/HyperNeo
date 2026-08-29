import superpipe, { type PipelineAPI } from 'superpipe';
import type { ProviderLoadFailure } from './model-service.js';
import { decideProviderRetryAction, type ProviderLoadOutcome } from './model-settlement-routing.js';
import type { ProviderFailureRecord } from './providers/provider-failure-store.js';

export interface SettleProviderLoadOutcomeDeps {
  getProviderRegistry(): { has(providerId: string): boolean };
  getAllProviderFailures(): readonly ProviderFailureRecord[];
  removeProviderFailure(providerId: string): boolean;
  clearProviderRetry(providerId: string): void;
  setProviderAppliedSeq(providerId: string, loadSeq: number): void;
  clearProviderFailure(providerId: string): boolean;
  getProviderFailure(providerId: string): ProviderFailureRecord | undefined;
  armProviderRetry(providerId: string): void;
  cancelProviderRetry(providerId: string): void;
  recordClassifiedProviderFailure(
    providerId: string,
    failure: { errorKind: 'transient' | 'credential'; message: string }
  ): ProviderFailureRecord;
  emitProviderSettlement(changedProviderIds: readonly string[]): void;
}

export interface SettleProviderLoadOutcomeResult {
  readonly appliedProviderIds: readonly string[];
  readonly clearedProviderIds: readonly string[];
  readonly armedProviderIds: readonly string[];
  readonly canceledProviderIds: readonly string[];
  readonly recordedFailures: readonly ProviderLoadFailure[];
  readonly changedProviderIds: readonly string[];
  readonly emitted: boolean;
}

export interface SettleProviderLoadOutcomeCtx {
  deps: SettleProviderLoadOutcomeDeps;
  outcomes: ProviderLoadOutcome[];
  loadSeq: number;
  result: SettleProviderLoadOutcomeResult;
}

function addUnique<T>(values: readonly T[], value: T): T[] {
  if (values.includes(value)) return values as T[];
  return [...values, value];
}

function unique<T>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (const value of values) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

export function cleanupOrphans(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  const registry = ctx.deps.getProviderRegistry();
  const changed = new Set(ctx.result.changedProviderIds);
  for (const failure of ctx.deps.getAllProviderFailures()) {
    if (registry.has(failure.providerId)) continue;
    ctx.deps.removeProviderFailure(failure.providerId);
    ctx.deps.clearProviderRetry(failure.providerId);
    changed.add(failure.providerId);
  }
  return { ...ctx, result: { ...ctx.result, changedProviderIds: Array.from(changed) } };
}

export function markApplied(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  const applied = [...ctx.result.appliedProviderIds];
  const changed = new Set(ctx.result.changedProviderIds);
  for (const outcome of ctx.outcomes) {
    if (outcome.kind !== 'loaded' && outcome.kind !== 'unavailable') continue;
    ctx.deps.setProviderAppliedSeq(outcome.providerId, ctx.loadSeq);
    applied.push(outcome.providerId);
    changed.add(outcome.providerId);
  }
  return {
    ...ctx,
    result: {
      ...ctx.result,
      appliedProviderIds: unique(applied),
      changedProviderIds: Array.from(changed),
    },
  };
}

export function settleRetries(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  let cleared = [...ctx.result.clearedProviderIds];
  let armed = [...ctx.result.armedProviderIds];
  let canceled = [...ctx.result.canceledProviderIds];
  const changed = new Set(ctx.result.changedProviderIds);
  for (const outcome of ctx.outcomes) {
    const registry = ctx.deps.getProviderRegistry();
    if (outcome.kind === 'failed' && !registry.has(outcome.providerId)) continue;
    let action = decideProviderRetryAction(outcome);
    if (
      outcome.kind === 'unavailable' &&
      ctx.deps.getProviderFailure(outcome.providerId)?.errorKind === 'transient'
    ) {
      action = 'arm';
    }
    if (action === 'clear') {
      ctx.deps.clearProviderFailure(outcome.providerId);
      ctx.deps.clearProviderRetry(outcome.providerId);
      cleared = addUnique(cleared, outcome.providerId);
      changed.add(outcome.providerId);
    } else if (action === 'arm') {
      ctx.deps.armProviderRetry(outcome.providerId);
      armed = addUnique(armed, outcome.providerId);
      changed.add(outcome.providerId);
    } else if (action === 'cancel') {
      ctx.deps.cancelProviderRetry(outcome.providerId);
      canceled = addUnique(canceled, outcome.providerId);
      changed.add(outcome.providerId);
    }
  }
  return {
    ...ctx,
    result: {
      ...ctx.result,
      clearedProviderIds: cleared,
      armedProviderIds: armed,
      canceledProviderIds: canceled,
      changedProviderIds: Array.from(changed),
    },
  };
}

export function recordFailures(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  const registry = ctx.deps.getProviderRegistry();
  const applied = [...ctx.result.appliedProviderIds];
  const recorded = [...ctx.result.recordedFailures];
  const changed = new Set(ctx.result.changedProviderIds);
  for (const outcome of ctx.outcomes) {
    if (outcome.kind !== 'failed' || !outcome.failure) continue;
    if (!registry.has(outcome.providerId)) continue;
    ctx.deps.setProviderAppliedSeq(outcome.providerId, ctx.loadSeq);
    ctx.deps.recordClassifiedProviderFailure(outcome.providerId, outcome.failure);
    applied.push(outcome.providerId);
    recorded.push(outcome.failure);
    changed.add(outcome.providerId);
  }
  return {
    ...ctx,
    result: {
      ...ctx.result,
      appliedProviderIds: unique(applied),
      recordedFailures: recorded,
      changedProviderIds: Array.from(changed),
    },
  };
}

export function emit(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  const changed = unique(ctx.result.changedProviderIds);
  if (changed.length > 0) {
    ctx.deps.emitProviderSettlement(changed);
  }
  return {
    ...ctx,
    result: { ...ctx.result, changedProviderIds: changed, emitted: changed.length > 0 },
  };
}

function outcomesEmpty(ctx: SettleProviderLoadOutcomeCtx): boolean {
  return ctx.outcomes.length === 0;
}

function emptyResult(): SettleProviderLoadOutcomeResult {
  return {
    appliedProviderIds: [],
    clearedProviderIds: [],
    armedProviderIds: [],
    canceledProviderIds: [],
    recordedFailures: [],
    changedProviderIds: [],
    emitted: false,
  };
}

const run = (
  superpipe<{ outcomesEmpty: (ctx: SettleProviderLoadOutcomeCtx) => boolean }>({
    outcomesEmpty,
  })('settle-provider-load-outcome') as PipelineAPI
)
  .input(['ctx'])
  .pipe(cleanupOrphans, 'ctx', 'ctx')
  .pipe('!outcomesEmpty', 'ctx')
  .pipe(markApplied, 'ctx', 'ctx')
  .pipe('!outcomesEmpty', 'ctx')
  .pipe(settleRetries, 'ctx', 'ctx')
  .pipe('!outcomesEmpty', 'ctx')
  .pipe(recordFailures, 'ctx', 'ctx')
  .pipe('!outcomesEmpty', 'ctx')
  .pipe(emit, 'ctx', 'ctx')
  .end('ctx') as (ctx: SettleProviderLoadOutcomeCtx) => SettleProviderLoadOutcomeCtx;

export function runSettleProviderLoadOutcome(
  deps: SettleProviderLoadOutcomeDeps,
  input: { outcomes: readonly ProviderLoadOutcome[]; loadSeq: number }
): SettleProviderLoadOutcomeResult {
  const ctx = run({
    deps,
    outcomes: input.outcomes as ProviderLoadOutcome[],
    loadSeq: input.loadSeq,
    result: emptyResult(),
  });
  return ctx.result;
}
