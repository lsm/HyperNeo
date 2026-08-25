import type { ModelInfo } from '@hyperneo/shared';
import type { Provider, ProviderSdkConfig } from '@hyperneo/shared/provider';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  getProviderCatalogModels,
  isCuratedOutModel,
  resolveVisibleCanonicalModelId,
} from './model-service.js';
import { getProviderRegistry } from './providers/registry.js';

export type TitleModelSelectionStatus = 'selected' | 'unavailable' | 'noProvider';

export interface TitleModelSelectionCtx {
  providerId: string;
  provider: Provider | undefined;
  candidates: Array<string | undefined>;
  ensureBuildable: boolean;
  ensureBridges: (provider: Provider, modelId: string) => Promise<void>;
  registry: ReturnType<typeof getProviderRegistry>;
  catalogModels: ModelInfo[];
  catalogLoaded?: boolean;
  providerModelId?: string;
  sdkConfig: ProviderSdkConfig | null;
  buildError?: unknown;
  status: TitleModelSelectionStatus | null;
}

export interface TitleModelSelectionInput
  extends Omit<
    TitleModelSelectionCtx,
    'registry' | 'catalogModels' | 'catalogLoaded' | 'sdkConfig' | 'status'
  > {}

export interface TitleModelSelectionResult {
  status: TitleModelSelectionStatus;
  providerModelId?: string;
  sdkConfig: ProviderSdkConfig | null;
  buildError?: unknown;
}

function settled(ctx: TitleModelSelectionCtx): boolean {
  return ctx.status !== null;
}

export function gateProviderPresence(ctx: TitleModelSelectionCtx): TitleModelSelectionCtx {
  return ctx.provider ? ctx : { ...ctx, status: 'noProvider' };
}

async function ensureCatalog(ctx: TitleModelSelectionCtx): Promise<ModelInfo[]> {
  if (ctx.catalogLoaded || !ctx.provider) return ctx.catalogModels;
  return getProviderCatalogModels(ctx.providerId, ctx.provider);
}

function withCatalog(
  ctx: TitleModelSelectionCtx,
  catalogModels: ModelInfo[]
): TitleModelSelectionCtx {
  return { ...ctx, catalogModels, catalogLoaded: true };
}

function curatedSetFor(providerId: string): Set<string> | undefined {
  const curatedModels = getProviderRegistry().getCuratedModels(providerId);
  if (curatedModels === undefined) return undefined;
  return new Set(curatedModels.map((model) => model.id));
}

export async function selectPreferredCandidateStage(
  ctx: TitleModelSelectionCtx
): Promise<TitleModelSelectionCtx> {
  const { providerId, registry, candidates } = ctx;
  if (registry.getCuratedModels(providerId) === undefined) {
    const preferred = candidates.find((candidate) => candidate !== undefined);
    if (preferred !== undefined) {
      return { ...ctx, providerModelId: preferred, status: 'selected' };
    }
    return ctx;
  }
  const curatedNow = registry.getCuratedModels(providerId);
  if (curatedNow !== undefined && curatedNow.length === 0) {
    return { ...ctx, status: 'unavailable' };
  }
  const catalogModels = await ensureCatalog(ctx);
  const catalogIds = new Set(catalogModels.map((model) => model.id));
  for (const candidate of candidates) {
    if (!candidate) continue;
    const canonicalId =
      (await resolveVisibleCanonicalModelId(candidate, providerId, 'global', catalogModels)) ??
      candidate;
    if (registry.getCuratedModels(providerId) === undefined) {
      return { ...ctx, providerModelId: canonicalId, status: 'selected' };
    }
    let allowed = curatedSetFor(providerId)?.has(canonicalId) ?? false;
    if (!allowed) {
      const curatedEntries = registry.getCuratedModels(providerId);
      if (curatedEntries === undefined) {
        return { ...ctx, providerModelId: canonicalId, status: 'selected' };
      }
      for (const entry of curatedEntries) {
        const entryCanonical =
          (await resolveVisibleCanonicalModelId(entry.id, providerId, 'global', catalogModels)) ??
          entry.id;
        if (entryCanonical === canonicalId) {
          allowed = true;
          break;
        }
      }
    }
    if (!allowed) continue;
    if (!catalogIds.has(canonicalId)) continue;
    return withCatalog({ ...ctx, providerModelId: canonicalId, status: 'selected' }, catalogModels);
  }
  return ctx;
}

export async function fallbackToVisibleCatalogStage(
  ctx: TitleModelSelectionCtx
): Promise<TitleModelSelectionCtx> {
  if (ctx.status !== null) return ctx;
  const { providerId, registry } = ctx;
  const catalogModels = await ensureCatalog(ctx);
  const catalogIds = new Set(catalogModels.map((model) => model.id));
  const curatedAfter = registry.getCuratedModels(providerId);
  if (curatedAfter === undefined) {
    const fallbackId = catalogModels[0]?.id;
    return fallbackId
      ? { ...ctx, providerModelId: fallbackId, status: 'selected' }
      : { ...ctx, status: 'unavailable' };
  }
  for (const entry of curatedAfter) {
    const canonical =
      (await resolveVisibleCanonicalModelId(entry.id, providerId, 'global', catalogModels)) ??
      entry.id;
    if (catalogIds.has(canonical)) {
      return withCatalog({ ...ctx, providerModelId: canonical, status: 'selected' }, catalogModels);
    }
  }
  return withCatalog({ ...ctx, status: 'unavailable' }, catalogModels);
}

async function healFromCatalog(
  ctx: TitleModelSelectionCtx,
  buildError?: unknown
): Promise<TitleModelSelectionCtx | null> {
  const { providerId, provider } = ctx;
  if (!provider) return null;
  const catalogModels = await getProviderCatalogModels(ctx.providerId, provider).catch(() => []);
  for (const model of catalogModels) {
    if (isCuratedOutModel(model.id, providerId)) continue;
    try {
      const sdkConfig = provider.buildSdkConfig(model.id);
      return {
        ...ctx,
        providerModelId: model.id,
        sdkConfig,
        ...(buildError ? { buildError } : {}),
      };
    } catch {}
  }
  return null;
}

export async function routeThroughProviderSdkStage(
  ctx: TitleModelSelectionCtx
): Promise<TitleModelSelectionCtx> {
  if (ctx.status !== 'selected') return ctx;
  if (!ctx.ensureBuildable || !ctx.provider || !ctx.providerModelId) {
    return ctx;
  }
  const { providerId, provider } = ctx;
  const modelId = ctx.providerModelId;
  await ctx.ensureBridges(provider, modelId);
  const curatedNow = getProviderRegistry().getCuratedModels(providerId);
  if (
    curatedNow !== undefined &&
    (curatedNow.length === 0 || isCuratedOutModel(modelId, providerId))
  ) {
    const healed = await healFromCatalog(ctx);
    return healed ?? { ...ctx, providerModelId: undefined, sdkConfig: null, status: 'unavailable' };
  }
  try {
    return { ...ctx, sdkConfig: provider.buildSdkConfig(modelId) };
  } catch (err) {
    const healed = await healFromCatalog(ctx, err);
    if (healed) return healed;
    return { ...ctx, sdkConfig: null, buildError: err };
  }
}

const titleModelSelectionPipeline = (superpipe({ settled })('title-model-selection') as PipelineAPI)
  .input(['ctx'])
  .pipe(gateProviderPresence, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(selectPreferredCandidateStage, 'ctx', 'ctx')
  .pipe(fallbackToVisibleCatalogStage, 'ctx', 'ctx')
  .pipe(routeThroughProviderSdkStage, 'ctx', 'ctx')
  .endAsync('ctx');

const run = titleModelSelectionPipeline as (
  input: TitleModelSelectionCtx
) => Promise<TitleModelSelectionCtx>;

export async function selectTitleGenerationModel(
  input: TitleModelSelectionInput
): Promise<TitleModelSelectionResult> {
  const result = await run({
    ...input,
    registry: getProviderRegistry(),
    catalogModels: [],
    sdkConfig: null,
    status: null,
  });
  return {
    status: result.status ?? 'unavailable',
    providerModelId: result.providerModelId,
    sdkConfig: result.sdkConfig,
    buildError: result.buildError,
  };
}
