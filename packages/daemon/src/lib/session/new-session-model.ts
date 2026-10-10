import type { GlobalSettings, ModelInfo } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { resolveFallbackChain } from '../agent/fallback-recovery.ts';
import { canonicalModelId, findInModels } from '../model-service.ts';
import { KimiProvider } from '../providers/kimi-provider.ts';
import { inferProviderForModel } from '../providers/registry.ts';
import { usableModels } from '../usable-models.ts';

export type NewSessionModelSettings = Pick<
  GlobalSettings,
  'model' | 'modelProvider' | 'fallbackModels' | 'modelFallbackMap'
>;

export interface NewSessionModelRequest {
  explicitModel?: string;
  explicitProvider?: string;
  defaultModel: string;
  defaultProvider?: string;
  requestedModel: string;
  requestedProvider?: string;
  settings: NewSessionModelSettings;
}

export interface NewSessionModelCatalog {
  models: ModelInfo[];
  error: unknown;
  requestedCuratedOut: boolean;
  inferredCuratedOut: boolean;
}

export type NewSessionModelDecision =
  | { kind: 'model'; id: string; provider?: string; fallbackFrom?: string }
  | { kind: 'curated_out'; model: string; provider: string }
  | { kind: 'unavailable'; model: string; provider?: string };

export function planNewSessionModelRequest(
  explicitModel: string | undefined,
  explicitProvider: string | undefined,
  settings: NewSessionModelSettings,
  configuredDefault: string
): NewSessionModelRequest {
  const defaultModel = settings.model || configuredDefault;
  const defaultProvider = settings.modelProvider ?? (explicitModel ? undefined : explicitProvider);
  return {
    explicitModel,
    explicitProvider,
    defaultModel,
    defaultProvider,
    requestedModel: explicitModel ?? defaultModel,
    requestedProvider: explicitModel ? explicitProvider : defaultProvider,
    settings,
  };
}

async function readNewSessionModelCatalog(
  request: NewSessionModelRequest
): Promise<NewSessionModelCatalog> {
  const { isCuratedOutModel, getAvailableModels } = await import('../model-service.ts');
  const { requestedModel, requestedProvider } = request;
  const requestedCuratedOut =
    !!requestedProvider && isCuratedOutModel(requestedModel, requestedProvider);
  const inferredCuratedOut = isCuratedOutModel(
    requestedModel,
    requestedProvider ?? inferProviderForModel(requestedModel)
  );
  try {
    return {
      models: getAvailableModels('global'),
      error: undefined,
      requestedCuratedOut,
      inferredCuratedOut,
    };
  } catch (error) {
    return { models: [], error, requestedCuratedOut, inferredCuratedOut };
  }
}

export function pickCatalogModel(
  models: ModelInfo[],
  model: string,
  provider: string | undefined
): { id: string; provider: string } | null {
  const found = findInModels(
    provider ? models.filter((m) => m.provider === provider) : models,
    model
  );
  if (!found) return null;
  return /\[1m\]$/i.test(model.trim()) &&
    !/\[1m\]$/i.test(found.id) &&
    KimiProvider.isKimiK3OneMModel(found.id)
    ? { id: `${found.id}[1m]`, provider: found.provider }
    : { id: found.id, provider: found.provider };
}

function decideFromCatalog(
  request: NewSessionModelRequest,
  models: ModelInfo[]
): NewSessionModelDecision {
  const { explicitModel, explicitProvider, defaultModel, defaultProvider, settings } = request;
  if (explicitModel) {
    const requested = pickCatalogModel(models, explicitModel, explicitProvider);
    if (requested) return { kind: 'model', ...requested };
    if (explicitProvider) return { kind: 'model', id: explicitModel, provider: explicitProvider };
  }
  const usable = usableModels(models);
  const byDefault = pickCatalogModel(usable, defaultModel, defaultProvider);
  if (byDefault) return { kind: 'model', ...byDefault };
  const chainProvider = defaultProvider ?? inferProviderForModel(defaultModel);
  const chain = resolveFallbackChain(
    chainProvider,
    canonicalModelId(chainProvider, defaultModel),
    settings.modelFallbackMap,
    settings.fallbackModels
  );
  for (const entry of chain) {
    const fallback = pickCatalogModel(usable, entry.model, entry.provider);
    if (fallback) return { kind: 'model', ...fallback, fallbackFrom: request.requestedModel };
  }
  return {
    kind: 'unavailable',
    model: request.requestedModel,
    provider: request.requestedProvider,
  };
}

export function decideNewSessionModel(
  request: NewSessionModelRequest,
  catalog: NewSessionModelCatalog
): NewSessionModelDecision {
  const { requestedModel, requestedProvider } = request;
  if (requestedProvider && catalog.requestedCuratedOut)
    return { kind: 'curated_out', model: requestedModel, provider: requestedProvider };
  if (catalog.models.length > 0) return decideFromCatalog(request, catalog.models);
  if (catalog.inferredCuratedOut)
    return {
      kind: 'curated_out',
      model: requestedModel,
      provider: requestedProvider ?? inferProviderForModel(requestedModel),
    };
  return {
    kind: 'model',
    id: requestedModel,
    ...(requestedProvider ? { provider: requestedProvider } : {}),
  };
}

function resolveFromCatalog(
  request: NewSessionModelRequest,
  catalog: NewSessionModelCatalog
): { catalog: NewSessionModelCatalog; decision: NewSessionModelDecision } {
  return { catalog, decision: decideNewSessionModel(request, catalog) };
}

export const resolveNewSessionModel = (superpipe({})('resolve-new-session-model') as PipelineAPI)
  .input(['explicitModel', 'explicitProvider', 'settings', 'configuredDefault'])
  .pipe(
    planNewSessionModelRequest,
    ['explicitModel', 'explicitProvider', 'settings', 'configuredDefault'],
    'request'
  )
  .pipe(readNewSessionModelCatalog, 'request', 'catalog')
  .pipe(resolveFromCatalog, ['request', 'catalog'], 'resolution')
  .endAsync('resolution') as (
  explicitModel: string | undefined,
  explicitProvider: string | undefined,
  settings: NewSessionModelSettings,
  configuredDefault: string
) => Promise<{ catalog: NewSessionModelCatalog; decision: NewSessionModelDecision }>;
