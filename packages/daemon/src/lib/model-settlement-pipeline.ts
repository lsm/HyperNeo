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
    failure: ProviderLoadFailure
  ): ProviderFailureRecord;
  emitProviderSettlement(providerIds: readonly string[]): void;
}

export interface SettleProviderLoadOutcomeResult {
  readonly appliedProviderIds: readonly string[];
  readonly clearedProviderIds: readonly string[];
  readonly armedProviderIds: readonly string[];
  readonly canceledProviderIds: readonly string[];
  readonly recordedFailures: readonly ProviderLoadFailure[];
  readonly emitted: boolean;
}

interface SettleProviderLoadOutcomeCtx {
  deps: SettleProviderLoadOutcomeDeps;
  outcomes: ProviderLoadOutcome[];
  loadSeq: number;
  result: SettleProviderLoadOutcomeResult;
}

function withResult(
  ctx: SettleProviderLoadOutcomeCtx,
  patch: Partial<SettleProviderLoadOutcomeResult>
): SettleProviderLoadOutcomeCtx {
  return { ...ctx, result: { ...ctx.result, ...patch } };
}

export function cleanupOrphans(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  const registry = ctx.deps.getProviderRegistry();
  for (const failure of ctx.deps.getAllProviderFailures()) {
    if (registry.has(failure.providerId)) continue;
    ctx.deps.removeProviderFailure(failure.providerId);
    ctx.deps.clearProviderRetry(failure.providerId);
  }
  return ctx;
}

export function markApplied(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  const applied: string[] = [...ctx.result.appliedProviderIds];
  for (const outcome of ctx.outcomes) {
    if (outcome.kind !== 'loaded') continue;
    ctx.deps.setProviderAppliedSeq(outcome.providerId, ctx.loadSeq);
    applied.push(outcome.providerId);
  }
  return withResult(ctx, { appliedProviderIds: Array.from(new Set(applied)) });
}

export function settleRetries(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  const registry = ctx.deps.getProviderRegistry();
  let cleared = [...ctx.result.clearedProviderIds];
  let armed = [...ctx.result.armedProviderIds];
  let canceled = [...ctx.result.canceledProviderIds];
  for (const outcome of ctx.outcomes) {
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
      cleared.push(outcome.providerId);
    } else if (action === 'arm') {
      ctx.deps.armProviderRetry(outcome.providerId);
      armed.push(outcome.providerId);
    } else if (action === 'cancel') {
      ctx.deps.cancelProviderRetry(outcome.providerId);
      canceled.push(outcome.providerId);
    }
  }
  return withResult(ctx, {
    clearedProviderIds: Array.from(new Set(cleared)),
    armedProviderIds: Array.from(new Set(armed)),
    canceledProviderIds: Array.from(new Set(canceled)),
  });
}

export function recordFailures(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  const registry = ctx.deps.getProviderRegistry();
  const applied: string[] = [...ctx.result.appliedProviderIds];
  const recorded: ProviderLoadFailure[] = [...ctx.result.recordedFailures];
  for (const outcome of ctx.outcomes) {
    if (outcome.kind !== 'failed' || !outcome.failure || !registry.has(outcome.providerId))
      continue;
    ctx.deps.setProviderAppliedSeq(outcome.providerId, ctx.loadSeq);
    ctx.deps.recordClassifiedProviderFailure(outcome.providerId, outcome.failure);
    applied.push(outcome.providerId);
    recorded.push(outcome.failure);
  }
  return withResult(ctx, {
    appliedProviderIds: Array.from(new Set(applied)),
    recordedFailures: recorded,
  });
}

export function emit(ctx: SettleProviderLoadOutcomeCtx): SettleProviderLoadOutcomeCtx {
  const changed = Array.from(
    new Set([
      ...ctx.result.appliedProviderIds,
      ...ctx.result.clearedProviderIds,
      ...ctx.result.armedProviderIds,
      ...ctx.result.canceledProviderIds,
      ...ctx.result.recordedFailures.map((failure) => failure.providerId),
    ])
  );
  if (changed.length > 0) {
    ctx.deps.emitProviderSettlement(changed);
  }
  return withResult(ctx, { emitted: changed.length > 0 });
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
  .pipe(settleRetries, 'ctx', 'ctx')
  .pipe(recordFailures, 'ctx', 'ctx')
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
