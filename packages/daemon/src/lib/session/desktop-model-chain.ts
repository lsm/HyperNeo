import type {
  CustomEndpointConfig,
  FallbackModelEntry,
  ModelInfo,
  ProviderCapabilities,
} from '@hyperneo/shared';
import { resolveCustomEndpointType } from '@hyperneo/shared/types/custom-endpoint';
import superpipe, { type PipelineAPI } from 'superpipe';
import { entryKey } from '../agent/fallback-recovery.ts';
import {
  customProviderIdFor,
  isCustomEndpointProviderId,
  resolveModelCapabilities,
} from '../providers/custom-endpoint-provider.ts';
import { pickCatalogModel } from './new-session-model.ts';

export class DesktopModelsExhaustedError extends Error {}

export interface DesktopProviderFacts {
  capabilities: Pick<ProviderCapabilities, 'vision' | 'functionCalling'>;
  sdk: boolean;
  isAvailable(): Promise<boolean> | boolean;
}

export interface DesktopModelSources {
  catalog(): Promise<ModelInfo[]> | ModelInfo[];
  provider(providerId: string): DesktopProviderFacts | null;
}

function seesScreenshots(
  entry: FallbackModelEntry,
  endpoints: readonly CustomEndpointConfig[],
  provider: DesktopProviderFacts | null
): boolean {
  if (!provider?.sdk) return false;
  if (!isCustomEndpointProviderId(entry.provider))
    return provider.capabilities.vision && provider.capabilities.functionCalling;
  const endpoint = endpoints.find(({ id }) => customProviderIdFor(id) === entry.provider);
  const model = endpoint?.models.find(({ id }) => id === entry.model);
  if (!endpoint || !model) return false;
  const type = resolveCustomEndpointType(endpoint);
  const capabilities = resolveModelCapabilities(model, type);
  return type === 'anthropic-messages' && capabilities.vision && capabilities.toolUse;
}

export function desktopControlChain(
  entries: readonly FallbackModelEntry[],
  models: ModelInfo[],
  endpoints: readonly CustomEndpointConfig[],
  provider: (providerId: string) => DesktopProviderFacts | null
): FallbackModelEntry[] {
  const chain = new Map<string, FallbackModelEntry>();
  for (const entry of entries) {
    const found = pickCatalogModel(models, entry.model, entry.provider);
    if (!found) continue;
    const canonical = {
      provider: found.provider,
      model: found.id,
      ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
    };
    if (chain.has(entryKey(canonical))) continue;
    if (seesScreenshots(canonical, endpoints, provider(canonical.provider)))
      chain.set(entryKey(canonical), canonical);
  }
  return [...chain.values()];
}

async function canRun(
  entry: FallbackModelEntry,
  models: ModelInfo[],
  provider: DesktopProviderFacts | null
): Promise<boolean> {
  const listed = models.some(
    (model) =>
      model.provider === entry.provider && model.id === entry.model && model.available !== false
  );
  if (!listed || !provider) return false;
  try {
    return await provider.isAvailable();
  } catch {
    return false;
  }
}

export interface DesktopModelSelection {
  chain: FallbackModelEntry[];
  selected: FallbackModelEntry;
}

async function readCatalog(sources: DesktopModelSources): Promise<ModelInfo[]> {
  try {
    return await sources.catalog();
  } catch {
    return [];
  }
}

function buildChain(
  entries: readonly FallbackModelEntry[],
  endpoints: readonly CustomEndpointConfig[] | undefined,
  models: ModelInfo[],
  sources: DesktopModelSources
): FallbackModelEntry[] {
  return desktopControlChain(entries, models, endpoints ?? [], (id) => sources.provider(id));
}

async function firstRunnable(
  chain: FallbackModelEntry[],
  models: ModelInfo[],
  sources: DesktopModelSources
): Promise<DesktopModelSelection> {
  for (const entry of chain)
    if (await canRun(entry, models, sources.provider(entry.provider)))
      return { chain, selected: entry };
  throw new DesktopModelsExhaustedError(
    chain.length
      ? 'No model in the desktop-control model list is available right now.'
      : 'No model in the desktop-control model list can see screenshots and use tools here.'
  );
}

export const selectDesktopControlModel = (
  superpipe({})('select-desktop-control-model') as PipelineAPI
)
  .input(['entries', 'endpoints', 'sources'])
  .pipe(readCatalog, 'sources', 'models')
  .pipe(buildChain, ['entries', 'endpoints', 'models', 'sources'], 'chain')
  .pipe(firstRunnable, ['chain', 'models', 'sources'], 'selection')
  .endAsync('selection') as (
  entries: readonly FallbackModelEntry[],
  endpoints: readonly CustomEndpointConfig[] | undefined,
  sources: DesktopModelSources
) => Promise<DesktopModelSelection>;
