/**
 * Custom Endpoint RPC Handlers
 *
 * CRUD over user-defined API endpoints (OpenAI Chat, Anthropic Messages,
 * Ollama native). Each mutation writes the full list back to
 * `settings.customEndpoints` and re-syncs the provider registry so changes
 * take effect immediately without a daemon restart.
 */

import type { MessageHub } from '@neokai/shared';
import type { CustomEndpointConfig, CustomEndpointType } from '@neokai/shared';
import { customProviderIdFor } from '../providers/custom-endpoint-provider.js';
import type { SettingsManager } from '../settings-manager';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import { Logger } from '../logger.js';

const VALID_CUSTOM_ENDPOINT_TYPES: ReadonlySet<CustomEndpointType> = new Set([
  'openai-chat',
  'anthropic-messages',
  'ollama-native',
]);

const log = new Logger('rpc-handlers:custom-endpoints');

/** Model list cache entry */
interface CachedModels {
  models: Array<{ id: string; name?: string }>;
  fetchedAt: number;
}

/** In-memory cache for model-list fetches (30s TTL). */
const modelListCache = new Map<string, CachedModels>();
const MODEL_LIST_CACHE_TTL_MS = 30_000;

// knip-ignore-next-line
/** Clear the model-list cache (used by tests). */
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

/**
 * Build the model-list URL by stripping known trailing suffixes from the
 * base URL path before appending the correct route. Mirrors the URL builders
 * in the bridge servers so a user-pasted `.../v1` or `.../v1/models` doesn't
 * produce a double-suffixed path like `.../v1/v1/models`.
 */
/**
 * Detect Azure OpenAI-style URLs (`…/openai/deployments/{name}/…`) and
 * return the deployment name as the only available model. Azure does not
 * expose a `/v1/models` equivalent, so we derive the model from the URL
 * path rather than probing a non-existent endpoint.
 */
function extractAzureDeploymentModel(baseUrl: string): { id: string } | null {
  const parsed = new URL(baseUrl.trim());
  const match = parsed.pathname.match(/\/openai\/deployments\/([^/]+)/i);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]) };
}

function buildModelListUrl(baseUrl: string, type: string): string {
  const trimmed = baseUrl.trim();
  const parsed = new URL(trimmed);
  let path = parsed.pathname.replace(/\/+$/, '');

  if (type === 'ollama-native') {
    path = path.replace(/\/api\/chat$/i, '');
    path = path.replace(/\/api\/tags$/i, '');
    parsed.pathname = `${path}/api/tags`;
  } else {
    path = path.replace(/\/chat\/completions$/i, '');
    path = path.replace(/\/v1\/messages\/count_tokens$/i, '');
    path = path.replace(/\/v1\/messages$/i, '');
    path = path.replace(/\/v1\/models$/i, '');
    path = path.replace(/\/v1$/i, '');
    parsed.pathname = `${path}/v1/models`;
  }
  return parsed.toString();
}

function normalizeModelList(type: string, data: unknown): Array<{ id: string; name?: string }> {
  if (type === 'ollama-native') {
    // Ollama /api/tags returns { models: [{ name, model?, ... }] }
    const body = data as { models?: Array<{ name?: string; model?: string }> } | undefined;
    const list = body?.models ?? [];
    return list
      .map((m) => {
        const id = m.name || m.model;
        if (!id) return null;
        return { id };
      })
      .filter((m): m is { id: string; name?: string } => m !== null);
  }

  if (type === 'anthropic-messages') {
    // Anthropic-compatible /v1/models returns { data: [{ id, type?, display_name? }] }
    const body = data as
      | {
          data?: Array<{
            id?: string;
            type?: string;
            display_name?: string;
            object?: string;
          }>;
        }
      | undefined;
    const list = body?.data ?? [];
    return list
      .map((m) => {
        const id = m.id;
        if (!id) return null;
        const isModel =
          m.type === 'model' ||
          m.object === 'model' ||
          (m.object === undefined && m.type === undefined);
        if (!isModel) return null;
        return m.display_name ? { id, name: m.display_name } : { id };
      })
      .filter((m): m is { id: string; name?: string } => m !== null);
  }

  // OpenAI-compatible /v1/models returns { data: [{ id, object? }] }
  const body = data as { data?: Array<{ id?: string; object?: string }> } | undefined;
  const list = body?.data ?? [];
  return list
    .map((m) => {
      const id = m.id;
      if (!id) return null;
      if (m.object !== undefined && m.object !== 'model') return null;
      return { id };
    })
    .filter((m): m is { id: string; name?: string } => m !== null);
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

/**
 * Validate a single endpoint. Exported for callers (e.g. the generic
 * `settings.global.update`/`save` RPCs) that need to reject invalid configs
 * before persisting and syncing the provider registry.
 */
export function validateCustomEndpoint(config: CustomEndpointConfig): void {
  if (!config?.id || typeof config.id !== 'string')
    throw new Error('Custom endpoint id is required');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(config.id))
    throw new Error(
      `Custom endpoint id '${config.id}' is invalid (allowed: letters, digits, '.', '_', '-')`
    );
  if (config.type !== undefined && !VALID_CUSTOM_ENDPOINT_TYPES.has(config.type)) {
    throw new Error(
      `Custom endpoint '${config.id}': type '${config.type}' is invalid (allowed: ${[
        ...VALID_CUSTOM_ENDPOINT_TYPES,
      ].join(', ')})`
    );
  }
  if (!config.name || typeof config.name !== 'string')
    throw new Error(`Custom endpoint '${config.id}': name is required`);
  if (!config.baseUrl || typeof config.baseUrl !== 'string')
    throw new Error(`Custom endpoint '${config.id}': baseUrl is required`);
  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('baseUrl must use http:// or https://');
    }
  } catch (err) {
    throw new Error(
      `Custom endpoint '${config.id}': invalid baseUrl — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Array.isArray(config.models) || config.models.length === 0)
    throw new Error(`Custom endpoint '${config.id}': at least one model is required`);
  const seen = new Set<string>();
  for (const model of config.models) {
    if (!model?.id || typeof model.id !== 'string')
      throw new Error(`Custom endpoint '${config.id}': every model must have an id`);
    if (seen.has(model.id))
      throw new Error(`Custom endpoint '${config.id}': duplicate model id '${model.id}'`);
    seen.add(model.id);
  }
  if (config.defaultModelId && !seen.has(config.defaultModelId)) {
    throw new Error(
      `Custom endpoint '${config.id}': defaultModelId '${config.defaultModelId}' not in models[]`
    );
  }
}

/**
 * Validate a list of endpoints, rejecting on duplicate ids in addition to all
 * per-entry checks. Used by the generic settings RPCs to keep stored settings
 * in sync with what the provider registry will accept.
 *
 * `undefined` means "field not provided" and is accepted as a no-op so callers
 * can pass `updates.customEndpoints` straight through; `null` is rejected
 * explicitly because it's a malformed payload (the field exists with a value
 * that is neither an array nor "not provided") that would otherwise sync as
 * empty and unregister all custom providers.
 */
export function validateCustomEndpoints(configs: CustomEndpointConfig[] | undefined): void {
  if (configs === undefined) return;
  if (configs === null) throw new Error('customEndpoints must be an array, got null');
  if (!Array.isArray(configs)) throw new Error('customEndpoints must be an array');
  const ids = new Set<string>();
  for (const config of configs) {
    validateCustomEndpoint(config);
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

async function persistAndSync(
  settingsManager: SettingsManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  endpoints: CustomEndpointConfig[],
  db?: Database
): Promise<void> {
  const updated = settingsManager.updateGlobalSettings({ customEndpoints: endpoints });
  const { syncCustomEndpointProviders } = await import('../providers/factory.js');
  await syncCustomEndpointProviders(endpoints);
  // Invalidate the cached global model list so newly added/removed custom
  // models become discoverable immediately instead of waiting for the TTL
  // to expire. Without this, model resolution can keep using stale defaults
  // until the next refresh.
  const { clearModelsCache } = await import('../model-service.js');
  clearModelsCache();
  internalEventBus.publishAsync('settings.updated', {
    namespaceId: 'global',
    settings: updated,
  });

  // Compat: sync the full list to the providers table so the unified registry
  // stays in sync with the legacy customEndpoints JSON blob.
  if (db) {
    const allProviderIds = new Set(endpoints.map((e) => customProviderIdFor(e.id)));
    for (const endpoint of endpoints) {
      syncEndpointToProviderTable(db, endpoint);
    }
    // Remove any provider records for endpoints that no longer exist.
    for (const record of db.providers.listProviders()) {
      if (record.kind === 'custom_endpoint' && !allProviderIds.has(record.providerId)) {
        db.providers.deleteProvider(record.id);
      }
    }
  }
}

/**
 * Serialise add/update/remove mutations on `settings.customEndpoints`.
 *
 * Each handler performs a read-modify-write on the JSON array; without a
 * lock two concurrent mutations would both read the same pre-update array
 * and whichever wrote last would overwrite the other, dropping changes.
 * A single in-process promise chain is sufficient since all RPC traffic
 * goes through one MessageHub on the daemon side.
 *
 * Exported so the generic `settings.global.update` / `settings.global.save`
 * RPCs can route their `customEndpoints` writes through the same queue.
 * Otherwise a concurrent settings-RPC write would race with an in-flight
 * `customEndpoints.add` and last-writer-wins would drop one mutation.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();
export function withCustomEndpointsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(fn, fn);
  // Swallow errors on the queue tail so one failure doesn't poison the chain.
  mutationQueue = run.catch(() => {});
  return run;
}

export function registerCustomEndpointHandlers(
  messageHub: MessageHub,
  settingsManager: SettingsManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  db?: Database
): void {
  /** List all configured custom endpoints. */
  messageHub.onRequest('customEndpoints.list', async () => {
    return { endpoints: settingsManager.getGlobalSettings().customEndpoints ?? [] };
  });

  /** Fetch available models from a custom endpoint. */
  messageHub.onRequest(
    'customEndpoints.listModels',
    async (data: {
      baseUrl: string;
      type?: string;
      apiKey?: string;
      headers?: Record<string, string>;
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
      const cached = modelListCache.get(key);
      if (cached && Date.now() - cached.fetchedAt < MODEL_LIST_CACHE_TTL_MS) {
        return { models: cached.models, fromCache: true };
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

  /** Add a new custom endpoint. Rejects when the id already exists. */
  messageHub.onRequest('customEndpoints.add', async (data: { endpoint: CustomEndpointConfig }) => {
    return withCustomEndpointsLock(async () => {
      validateCustomEndpoint(data.endpoint);
      const current = settingsManager.getGlobalSettings().customEndpoints ?? [];
      if (current.some((e) => e.id === data.endpoint.id)) {
        throw new Error(`Custom endpoint '${data.endpoint.id}' already exists`);
      }
      const next = [...current, data.endpoint];
      await persistAndSync(settingsManager, internalEventBus, next, db);
      return { success: true, endpoint: data.endpoint };
    });
  });

  /** Update an existing custom endpoint. Replaces the entry by id. */
  messageHub.onRequest(
    'customEndpoints.update',
    async (data: { endpoint: CustomEndpointConfig }) => {
      return withCustomEndpointsLock(async () => {
        validateCustomEndpoint(data.endpoint);
        const current = settingsManager.getGlobalSettings().customEndpoints ?? [];
        const index = current.findIndex((e) => e.id === data.endpoint.id);
        if (index === -1) throw new Error(`Custom endpoint '${data.endpoint.id}' not found`);
        const next = [...current.slice(0, index), data.endpoint, ...current.slice(index + 1)];
        await persistAndSync(settingsManager, internalEventBus, next, db);
        return { success: true, endpoint: data.endpoint };
      });
    }
  );

  /** Remove a custom endpoint by id. */
  messageHub.onRequest('customEndpoints.remove', async (data: { id: string }) => {
    return withCustomEndpointsLock(async () => {
      const current = settingsManager.getGlobalSettings().customEndpoints ?? [];
      const next = current.filter((e) => e.id !== data.id);
      if (next.length === current.length) {
        throw new Error(`Custom endpoint '${data.id}' not found`);
      }
      removeEndpointFromProviderTable(db, data.id);
      await persistAndSync(settingsManager, internalEventBus, next, db);
      return { success: true };
    });
  });
}
