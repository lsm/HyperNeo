import superpipe, { type PipelineAPI } from 'superpipe';
import type { ProviderSessionConfig } from '@hyperneo/shared/provider';
import {
  ensureScopedProviderCatalogModels,
  getCuratedModelIds,
  isCuratedOutModelAllowingExactId,
  isModelExcludedByCuration,
} from '../model-service.ts';

export type FallbackModelCurationOutcome = 'allowed' | 'excluded' | 'cancelled';

export interface FallbackModelCurationCtx {
  providerId: string;
  fallbackModel: string;
  cacheKey: string;
  providerConfig: ProviderSessionConfig;
  sessionScopedProvider: boolean;
  signalAborted: boolean;
  guardsIntact: () => boolean;
  outcome: FallbackModelCurationOutcome | null;
}

export type FallbackModelCurationInput = Omit<FallbackModelCurationCtx, 'outcome'>;

function settled(ctx: FallbackModelCurationCtx): boolean {
  return ctx.outcome !== null;
}

function cancelled(ctx: FallbackModelCurationCtx): FallbackModelCurationCtx {
  return { ...ctx, outcome: 'cancelled' };
}

export function gateEntryConditions(ctx: FallbackModelCurationCtx): FallbackModelCurationCtx {
  return ctx.signalAborted || !ctx.guardsIntact() ? cancelled(ctx) : ctx;
}

export async function ensureScopedCatalogStage(
  ctx: FallbackModelCurationCtx
): Promise<FallbackModelCurationCtx> {
  if (!ctx.sessionScopedProvider || getCuratedModelIds(ctx.providerId) === undefined) {
    return ctx;
  }
  await ensureScopedProviderCatalogModels(ctx.cacheKey, ctx.providerId, ctx.providerConfig);
  return ctx;
}

export async function evaluateFallbackCurationStage(
  ctx: FallbackModelCurationCtx
): Promise<FallbackModelCurationCtx> {
  if (!ctx.sessionScopedProvider) {
    const excluded = await isModelExcludedByCuration(ctx.fallbackModel, ctx.providerId);
    return excluded ? { ...ctx, outcome: 'excluded' } : ctx;
  }
  if (getCuratedModelIds(ctx.providerId) === undefined) {
    return ctx;
  }
  const excluded = isCuratedOutModelAllowingExactId(
    ctx.fallbackModel,
    ctx.providerId,
    ctx.cacheKey
  );
  return excluded ? { ...ctx, outcome: 'excluded' } : ctx;
}

export function gateExitConditions(ctx: FallbackModelCurationCtx): FallbackModelCurationCtx {
  return ctx.signalAborted || !ctx.guardsIntact() ? cancelled(ctx) : ctx;
}

export function finalizeAllowed(ctx: FallbackModelCurationCtx): FallbackModelCurationCtx {
  return { ...ctx, outcome: 'allowed' };
}

const fallbackModelCurationPipeline = (
  superpipe({ settled })('fallback-model-curation') as PipelineAPI
)
  .input(['ctx'])
  .pipe(gateEntryConditions, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(ensureScopedCatalogStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(evaluateFallbackCurationStage, 'ctx', 'ctx')
  .pipe(gateExitConditions, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(finalizeAllowed, 'ctx', 'ctx')
  .endAsync();

const run = fallbackModelCurationPipeline as (
  input: FallbackModelCurationCtx
) => Promise<FallbackModelCurationCtx>;

export async function decideFallbackModelCuration(
  input: FallbackModelCurationInput
): Promise<FallbackModelCurationOutcome> {
  const result = await run({ ...input, outcome: null });
  return result.outcome ?? 'cancelled';
}
