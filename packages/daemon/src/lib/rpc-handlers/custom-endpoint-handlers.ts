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

/**
 * Sync the full custom endpoint list to the providers table.
 * Disabled endpoints are still updated so re-enablement uses the latest config.
 */
export function syncCustomEndpointsToProviderTable(
  db: Database,
  endpoints: CustomEndpointConfig[]
): void {
  if (!db?.providers?.listProviders) return;
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

async function persistAndSync(
  settingsManager: SettingsManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  endpoints: CustomEndpointConfig[],
  db?: Database
): Promise<void> {
  // Filter out custom endpoints disabled in the providers table so legacy
  // sync does not re-register them despite is_enabled = 0.
  const syncEndpoints = db ? filterDisabledCustomEndpoints(endpoints, db) : endpoints;

  const updated = settingsManager.updateGlobalSettings({ customEndpoints: endpoints });
  const { syncCustomEndpointProviders } = await import('../providers/factory.js');
  await syncCustomEndpointProviders(syncEndpoints);
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
  internalEventBus.publishAsync('providers.changed', {
    sessionId: 'global',
  });

  // Compat: sync the full list to the providers table so the unified registry
  // stays in sync with the legacy customEndpoints JSON blob.
  if (db) {
    syncCustomEndpointsToProviderTable(db, endpoints);
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

/**
 * Filter out custom endpoints that are disabled in the providers table.
 * Used by both the legacy custom-endpoint handlers and the generic settings
 * handlers so disabled endpoints are not re-registered by unrelated syncs.
 */
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
  db?: Database
): void {
  /** List all configured custom endpoints. */
  messageHub.onRequest('customEndpoints.list', async () => {
    return { endpoints: settingsManager.getGlobalSettings().customEndpoints ?? [] };
  });

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
