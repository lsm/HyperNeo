import type { MessageHub } from '@hyperneo/shared';
import type { CustomEndpointConfig, CustomEndpointType } from '@hyperneo/shared';
import { AUTO_COMPACT_PERCENT_MAX, AUTO_COMPACT_PERCENT_MIN } from '@hyperneo/shared';
import { customProviderIdFor } from '../providers/custom-endpoint-provider.js';
import {
  buildModelListUrl,
  extractAzureDeploymentModel,
  normalizeModelList,
} from '../providers/shared/model-list.js';
import type { SettingsManager } from '../settings-manager.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Database } from '../../storage/database.ts';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import {
  publishGlobalSettings,
  VOICE_CREDENTIAL_PROVIDER_ID,
  EXA_CREDENTIAL_PROVIDER_ID,
} from './settings-handlers.ts';
import { Logger } from '../logger.js';

const VALID_CUSTOM_ENDPOINT_TYPES: ReadonlySet<CustomEndpointType> = new Set([
  'openai-chat',
  'anthropic-messages',
  'ollama-native',
]);

const log = new Logger('rpc-handlers:custom-endpoints');

interface CachedModels {
  models: Array<{ id: string; name?: string }>;
  fetchedAt: number;
}

const modelListCache = new Map<string, CachedModels>();
const MODEL_LIST_CACHE_TTL_MS = 30_000;

// knip-ignore-next-line
export function clearModelListCache(): void {
  modelListCache.clear();
}

function cacheKey(params: {
  baseUrl: string;
  type?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): string {
  return JSON.stringify([
    params.baseUrl,
    params.type ?? 'openai-chat',
    params.apiKey ?? '',
    JSON.stringify(params.headers ?? {}),
  ]);
}

async function fetchModelsFromEndpoint(params: {
  baseUrl: string;
  type?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): Promise<Array<{ id: string; name?: string }>> {
  const resolvedType = (params.type ?? 'openai-chat') as string;
  const probeUrl = buildModelListUrl(params.baseUrl, resolvedType);

  const headers: Record<string, string> = {};
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
    if (resolvedType === 'anthropic-messages') {
      headers['x-api-key'] = params.apiKey;
    }
  }
  if (resolvedType === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
  }
  if (params.headers) Object.assign(headers, params.headers);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const resp = await fetch(probeUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Endpoint returned HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return normalizeModelList(resolvedType, data);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out after 10s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function baseUrlProblem(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : 'baseUrl must use http:// or https://';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function endpointModelProblem(
  id: string,
  model: CustomEndpointConfig['models'][number]
): string | null {
  const pct = model.capabilities?.autoCompactPercent;
  if (
    pct !== undefined &&
    (typeof pct !== 'number' ||
      !Number.isFinite(pct) ||
      !Number.isInteger(pct) ||
      pct < AUTO_COMPACT_PERCENT_MIN ||
      pct > AUTO_COMPACT_PERCENT_MAX)
  )
    return `Custom endpoint '${id}': model '${model.id}' autoCompactPercent must be between ${AUTO_COMPACT_PERCENT_MIN} and ${AUTO_COMPACT_PERCENT_MAX}`;
  const off = model.capabilities?.thinkingOffEffort;
  if (off !== undefined && off !== 'none' && off !== 'minimal' && off !== 'low')
    return `Custom endpoint '${id}': model '${model.id}' thinkingOffEffort must be none, minimal or low`;
  return null;
}

export function customEndpointProblem(
  config: CustomEndpointConfig,
  options?: { allowReservedIds?: ReadonlySet<string> }
): string | null {
  if (!config?.id || typeof config.id !== 'string') return 'Custom endpoint id is required';
  if (
    (config.id === VOICE_CREDENTIAL_PROVIDER_ID || config.id === EXA_CREDENTIAL_PROVIDER_ID) &&
    !options?.allowReservedIds?.has(config.id)
  )
    return `Custom endpoint id '${config.id}' is reserved`;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(config.id))
    return `Custom endpoint id '${config.id}' is invalid (allowed: letters, digits, '.', '_', '-')`;
  if (config.type !== undefined && !VALID_CUSTOM_ENDPOINT_TYPES.has(config.type))
    return `Custom endpoint '${config.id}': type '${config.type}' is invalid (allowed: ${[
      ...VALID_CUSTOM_ENDPOINT_TYPES,
    ].join(', ')})`;
  if (!config.name || typeof config.name !== 'string')
    return `Custom endpoint '${config.id}': name is required`;
  if (!config.baseUrl || typeof config.baseUrl !== 'string')
    return `Custom endpoint '${config.id}': baseUrl is required`;
  const urlProblem = baseUrlProblem(config.baseUrl);
  if (urlProblem) return `Custom endpoint '${config.id}': invalid baseUrl — ${urlProblem}`;
  if (!Array.isArray(config.models) || config.models.length === 0)
    return `Custom endpoint '${config.id}': at least one model is required`;
  const seen = new Set<string>();
  for (const model of config.models) {
    if (!model?.id || typeof model.id !== 'string')
      return `Custom endpoint '${config.id}': every model must have an id`;
    if (seen.has(model.id))
      return `Custom endpoint '${config.id}': duplicate model id '${model.id}'`;
    const modelProblem = endpointModelProblem(config.id, model);
    if (modelProblem) return modelProblem;
    seen.add(model.id);
  }
  if (config.defaultModelId && !seen.has(config.defaultModelId))
    return `Custom endpoint '${config.id}': defaultModelId '${config.defaultModelId}' not in models[]`;
  return null;
}

export function validateCustomEndpoint(
  config: CustomEndpointConfig,
  options?: { allowReservedIds?: ReadonlySet<string> }
): void {
  const problem = customEndpointProblem(config, options);
  if (problem) throw new Error(problem);
}

export function validateCustomEndpoints(
  configs: CustomEndpointConfig[] | undefined,
  options?: { allowReservedIds?: ReadonlySet<string> }
): void {
  if (configs === undefined) return;
  if (configs === null) throw new Error('customEndpoints must be an array, got null');
  if (!Array.isArray(configs)) throw new Error('customEndpoints must be an array');
  const ids = new Set<string>();
  for (const config of configs) {
    validateCustomEndpoint(config, options);
    if (ids.has(config.id)) throw new Error(`Duplicate custom endpoint id '${config.id}'`);
    ids.add(config.id);
  }
}

function endpointToProviderRecord(endpoint: CustomEndpointConfig): {
  providerId: string;
  displayName: string;
  kind: 'custom_endpoint';
  authType: 'api_key' | 'none';
  baseUrl: string;
  customEndpointConfigJson: string;
} {
  return {
    providerId: customProviderIdFor(endpoint.id),
    displayName: endpoint.name,
    kind: 'custom_endpoint' as const,
    authType: 'none' as const,
    baseUrl: endpoint.baseUrl,
    customEndpointConfigJson: JSON.stringify(endpoint),
  };
}

function syncEndpointToProviderTable(
  db: Database | undefined,
  endpoint: CustomEndpointConfig
): void {
  if (!db) return;
  const existing = db.providers.getProviderByProviderId(customProviderIdFor(endpoint.id));
  if (existing) {
    db.providers.updateProvider(existing.id, {
      displayName: endpoint.name,
      baseUrl: endpoint.baseUrl,
      customEndpointConfigJson: JSON.stringify(endpoint),
    });
  } else {
    try {
      db.providers.createProvider({
        ...endpointToProviderRecord(endpoint),
        authType: 'none',
      });
    } catch (err) {
      log.warn('Failed to create provider record for custom endpoint:', err);
    }
  }
}

function removeEndpointFromProviderTable(db: Database | undefined, endpointId: string): void {
  if (!db) return;
  const existing = db.providers.getProviderByProviderId(customProviderIdFor(endpointId));
  if (existing) {
    db.providers.deleteProvider(existing.id);
  }
}

export function syncCustomEndpointsToProviderTable(
  db: Database,
  endpoints: CustomEndpointConfig[]
): void {
  if (!db?.providers?.listProviders) return;
  const allProviderIds = new Set(endpoints.map((e) => customProviderIdFor(e.id)));
  for (const endpoint of endpoints) {
    syncEndpointToProviderTable(db, endpoint);
  }
  for (const record of db.providers.listProviders()) {
    if (record.kind === 'custom_endpoint' && !allProviderIds.has(record.providerId)) {
      db.providers.deleteProvider(record.id);
    }
  }
}

async function persistAndSync(
  settingsManager: SettingsManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  endpoints: CustomEndpointConfig[],
  db?: Database,
  credentialManager?: ProviderCredentialManager
): Promise<void> {
  const syncEndpoints = db ? filterDisabledCustomEndpoints(endpoints, db) : endpoints;

  const updated = settingsManager.updateGlobalSettings({ customEndpoints: endpoints });
  const { syncCustomEndpointProviders } = await import('../providers/factory.js');
  await syncCustomEndpointProviders(syncEndpoints);
  const { clearModelsCache } = await import('../model-service.js');
  clearModelsCache();
  publishGlobalSettings(internalEventBus, updated, credentialManager);
  internalEventBus.publishAsync('providers.changed', {
    sessionId: 'global',
  });

  if (db) {
    syncCustomEndpointsToProviderTable(db, endpoints);
  }
}

let mutationQueue: Promise<unknown> = Promise.resolve();
export function withCustomEndpointsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

export function filterDisabledCustomEndpoints(
  endpoints: CustomEndpointConfig[],
  db: Database
): CustomEndpointConfig[] {
  if (!db?.providers?.listProviders) return endpoints;
  const disabledIds = new Set(
    db.providers
      .listProviders()
      .filter((p) => p.kind === 'custom_endpoint' && !p.isEnabled)
      .map((p) => p.providerId)
  );
  return endpoints.filter((e) => !disabledIds.has(customProviderIdFor(e.id)));
}

export function registerCustomEndpointHandlers(
  messageHub: MessageHub,
  settingsManager: SettingsManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  db?: Database,
  credentialManager?: ProviderCredentialManager
): void {
  messageHub.onRequest('customEndpoints.list', async () => {
    return { endpoints: settingsManager.getGlobalSettings().customEndpoints ?? [] };
  });

  messageHub.onRequest(
    'customEndpoints.listModels',
    async (data: {
      baseUrl: string;
      type?: string;
      apiKey?: string;
      headers?: Record<string, string>;
      force?: boolean;
    }) => {
      if (!data?.baseUrl || typeof data.baseUrl !== 'string')
        throw new Error('baseUrl is required');
      let url: URL;
      try {
        url = new URL(data.baseUrl);
      } catch {
        throw new Error('Invalid baseUrl');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('baseUrl must use http:// or https://');
      }

      const key = cacheKey(data);
      if (!data.force) {
        const cached = modelListCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < MODEL_LIST_CACHE_TTL_MS) {
          return { models: cached.models, fromCache: true };
        }
      }

      const azureModel = extractAzureDeploymentModel(data.baseUrl);
      if (azureModel) {
        const models = [azureModel];
        modelListCache.set(key, { models, fetchedAt: Date.now() });
        return { models, fromCache: false };
      }

      const models = await fetchModelsFromEndpoint(data);
      modelListCache.set(key, { models, fetchedAt: Date.now() });
      return { models, fromCache: false };
    }
  );

  messageHub.onRequest('customEndpoints.add', async (data: { endpoint: CustomEndpointConfig }) => {
    return withCustomEndpointsLock(async () => {
      validateCustomEndpoint(data.endpoint);
      const current = settingsManager.getGlobalSettings().customEndpoints ?? [];
      if (current.some((e) => e.id === data.endpoint.id)) {
        throw new Error(`Custom endpoint '${data.endpoint.id}' already exists`);
      }
      const next = [...current, data.endpoint];
      await persistAndSync(settingsManager, internalEventBus, next, db, credentialManager);
      return { success: true, endpoint: data.endpoint };
    });
  });

  messageHub.onRequest(
    'customEndpoints.update',
    async (data: { endpoint: CustomEndpointConfig }) => {
      return withCustomEndpointsLock(async () => {
        const current = settingsManager.getGlobalSettings().customEndpoints ?? [];
        validateCustomEndpoint(data.endpoint, {
          allowReservedIds: new Set(current.map((endpoint) => endpoint.id)),
        });
        const index = current.findIndex((e) => e.id === data.endpoint.id);
        if (index === -1) throw new Error(`Custom endpoint '${data.endpoint.id}' not found`);
        const next = [...current.slice(0, index), data.endpoint, ...current.slice(index + 1)];
        await persistAndSync(settingsManager, internalEventBus, next, db, credentialManager);
        return { success: true, endpoint: data.endpoint };
      });
    }
  );

  messageHub.onRequest('customEndpoints.remove', async (data: { id: string }) => {
    return withCustomEndpointsLock(async () => {
      const current = settingsManager.getGlobalSettings().customEndpoints ?? [];
      const next = current.filter((e) => e.id !== data.id);
      if (next.length === current.length) {
        throw new Error(`Custom endpoint '${data.id}' not found`);
      }
      removeEndpointFromProviderTable(db, data.id);
      await persistAndSync(settingsManager, internalEventBus, next, db, credentialManager);
      return { success: true };
    });
  });
}
