/**
 * Provider RPC Handlers
 *
 * Unified CRUD for the providers table. Bridges persistence, credential storage,
 * and the live ProviderRegistry so changes take effect immediately.
 */

import type { MessageHub } from '@hyperneo/shared';
import { VOICE_CREDENTIAL_PROVIDER_ID } from './settings-handlers';
import type { CreateProviderParams, UpdateProviderParams } from '@hyperneo/shared';
import type { ProviderCredentials } from '@hyperneo/shared/provider';
import type { ProviderRepository } from '../../storage/repositories/provider-repository';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager';
import {
  KEYCHAIN_UNAVAILABLE_MESSAGE,
  KeychainUnavailableError,
} from '../credentials/credential-store.js';
import { syncProviderToRegistry, removeProviderFromRegistry } from '../providers/provider-sync.js';
import { getProviderRegistry } from '../providers/registry.js';
import { markBuiltInProviderDisabled } from '../providers/factory.js';
import { withCustomEndpointsLock } from './custom-endpoint-handlers.js';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { Logger } from '../logger';

const log = new Logger('provider-handlers');

const VALID_PROVIDER_KINDS = new Set(['built_in', 'custom_endpoint']);
const VALID_AUTH_TYPES = new Set(['api_key', 'oauth', 'none']);

const MAX_PROVIDER_ID_LEN = 128;
const MAX_DISPLAY_NAME_LEN = 256;
const MAX_BASE_URL_LEN = 2048;
const MAX_JSON_FIELD_LEN = 64 * 1024;

function validateCreateParams(params: unknown): asserts params is CreateProviderParams {
  if (!params || typeof params !== 'object') throw new Error('Invalid provider params');
  const p = params as Record<string, unknown>;
  if (!p.providerId || typeof p.providerId !== 'string') throw new Error('providerId is required');
  if (p.providerId === VOICE_CREDENTIAL_PROVIDER_ID)
    throw new Error(`providerId '${VOICE_CREDENTIAL_PROVIDER_ID}' is reserved`);
  if (p.providerId.length > MAX_PROVIDER_ID_LEN)
    throw new Error(`providerId must be ≤ ${MAX_PROVIDER_ID_LEN} chars`);
  if (!p.displayName || typeof p.displayName !== 'string')
    throw new Error('displayName is required');
  if (p.displayName.length > MAX_DISPLAY_NAME_LEN)
    throw new Error(`displayName must be ≤ ${MAX_DISPLAY_NAME_LEN} chars`);
  const kind = typeof p.kind === 'string' ? p.kind : '';
  if (!VALID_PROVIDER_KINDS.has(kind))
    throw new Error(`kind must be one of: ${[...VALID_PROVIDER_KINDS].join(', ')}`);
  const authType = typeof p.authType === 'string' ? p.authType : '';
  if (!VALID_AUTH_TYPES.has(authType))
    throw new Error(`authType must be one of: ${[...VALID_AUTH_TYPES].join(', ')}`);
  if (typeof p.baseUrl === 'string' && p.baseUrl.length > MAX_BASE_URL_LEN)
    throw new Error(`baseUrl must be ≤ ${MAX_BASE_URL_LEN} chars`);
  if (typeof p.configJson === 'string' && p.configJson.length > MAX_JSON_FIELD_LEN)
    throw new Error(`configJson must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
  if (
    typeof p.customEndpointConfigJson === 'string' &&
    p.customEndpointConfigJson.length > MAX_JSON_FIELD_LEN
  )
    throw new Error(`customEndpointConfigJson must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
}

function validateUpdateParams(params: unknown): Partial<UpdateProviderParams> {
  if (!params || typeof params !== 'object') throw new Error('Invalid provider update params');
  const p = params as Record<string, unknown>;
  const out: Partial<UpdateProviderParams> = {};
  if (p.displayName !== undefined) {
    if (typeof p.displayName !== 'string') throw new Error('displayName must be a string');
    if (p.displayName.length > MAX_DISPLAY_NAME_LEN)
      throw new Error(`displayName must be ≤ ${MAX_DISPLAY_NAME_LEN} chars`);
    out.displayName = p.displayName;
  }
  if (p.authType !== undefined) {
    const authType = typeof p.authType === 'string' ? p.authType : '';
    if (!VALID_AUTH_TYPES.has(authType)) throw new Error('Invalid authType');
    out.authType = authType as 'api_key' | 'oauth' | 'none';
  }
  if (p.isEnabled !== undefined) out.isEnabled = Boolean(p.isEnabled);
  if (p.isDefault !== undefined) out.isDefault = Boolean(p.isDefault);
  if (p.sortOrder !== undefined) out.sortOrder = Number(p.sortOrder);
  if ('baseUrl' in p) {
    const val = p.baseUrl === undefined ? undefined : String(p.baseUrl);
    if (val !== undefined && val.length > MAX_BASE_URL_LEN)
      throw new Error(`baseUrl must be ≤ ${MAX_BASE_URL_LEN} chars`);
    out.baseUrl = val;
  }
  if ('configJson' in p) {
    const val = p.configJson === undefined ? undefined : String(p.configJson);
    if (val !== undefined && val.length > MAX_JSON_FIELD_LEN)
      throw new Error(`configJson must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
    out.configJson = val;
  }
  if ('customEndpointConfigJson' in p) {
    const val =
      p.customEndpointConfigJson === undefined ? undefined : String(p.customEndpointConfigJson);
    if (val !== undefined && val.length > MAX_JSON_FIELD_LEN)
      throw new Error(`customEndpointConfigJson must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
    out.customEndpointConfigJson = val;
  }
  return out;
}

/**
 * Shape of the credential payload carried on `providers.create`/`update` RPCs.
 * Kept structural so this module doesn't depend on the request DTO.
 */
type RequestCredentials = {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: number;
};

/**
 * Resolve the credential object to hydrate the live provider instance with,
 * after a create/update has persisted credentials for `providerId`.
 *
 * - New API key in the request → hydrate directly from it. It is the
 *   authoritative key the user just entered, and reading it back from the
 *   credential store can return either a stale macOS-Keychain value (when the
 *   fresh write fell through to the encrypted fallback while the Keychain
 *   remained readable) or null (locked-Keychain read) — either outcome would
 *   leave the live provider un-hydrated, so `isAvailable()` stays false and its
 *   models never reach the picker even though the Provider panel shows it
 *   "connected". Hydrating from the request closes that gap without a restart.
 * - New OAuth token in the request → prefer the store's normalised shape (it
 *   carries the `raw` metadata OAuth providers like Codex attach during
 *   `storeOAuthTokens`), falling back to the request value if the store read is
 *   empty so the provider is still hydrated.
 * - No new credentials (config-only resync, e.g. a Kimi region change) →
 *   preserve the live provider's existing credentials rather than re-reading
 *   the store. A prior request-derived hydration may hold a key the credential
 *   store still reports as stale (locked-keychain fallback read), and
 *   overwriting it would reintroduce the connected-vs-available gap. Falls
 *   back to the store only when the live instance has no credentials yet
 *   (e.g. it was just re-registered after being re-enabled).
 */
export async function resolveCredentialsForHydration(
  credentialManager: ProviderCredentialManager,
  providerId: string,
  requestCreds: RequestCredentials | undefined
): Promise<ProviderCredentials | null> {
  if (requestCreds?.apiKey) {
    return { type: 'api_key', apiKey: requestCreds.apiKey };
  }
  if (requestCreds?.oauthAccessToken) {
    // Submitted tokens are authoritative — same stale-read rationale as the
    // API-key branch (a fallback keychain write can leave the store reporting
    // an older OAuth token that would otherwise win here). Preserve any `raw`
    // metadata the store normalised (e.g. Codex accountId/planType/fedramp) so
    // the OAuth provider keeps its enriched state.
    const stored = await credentialManager.getCredentials(providerId);
    const raw = stored?.type === 'oauth' ? stored.raw : undefined;
    return {
      type: 'oauth',
      accessToken: requestCreds.oauthAccessToken,
      refreshToken: requestCreds.oauthRefreshToken,
      expiresAt: requestCreds.oauthExpiresAt,
      ...(raw ? { raw } : {}),
    };
  }
  // Config-only resync: preserve the live provider's credentials instead of
  // re-reading a potentially-stale store value.
  const provider = getProviderRegistry().get(providerId);
  if (provider?.getCredentials) {
    const live = await provider.getCredentials();
    if (live) return live;
  }
  return credentialManager.getCredentials(providerId);
}

// ---------------------------------------------------------------------------
// Mutation lock — serialises all provider mutations
// ---------------------------------------------------------------------------

let mutationQueue: Promise<unknown> = Promise.resolve();

function withProviderLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

/**
 * Normalises a `KeychainUnavailableError` into a plain `Error` carrying
 * `KEYCHAIN_UNAVAILABLE_MESSAGE` so the RPC layer serialises actionable UX
 * guidance to the client. Other errors pass through unchanged. `action` and
 * `providerId` feed the structured warn log so operators can correlate the
 * failed mutation in daemon logs.
 */
function rethrowKeychainError(err: unknown, action: string, providerId: string): never {
  if (err instanceof KeychainUnavailableError) {
    log.warn(`Provider ${action} blocked for ${providerId}: ${KEYCHAIN_UNAVAILABLE_MESSAGE}`);
    throw new Error(KEYCHAIN_UNAVAILABLE_MESSAGE);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------------

export interface ProviderHandlerDeps {
  messageHub: MessageHub;
  providerRepo: ProviderRepository;
  credentialManager: ProviderCredentialManager;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
}

async function clearCacheAndNotifyProvidersChanged(
  internalEventBus: InternalEventBus<DaemonInternalEventMap>
): Promise<void> {
  const { clearModelsCache } = await import('../model-service.js');
  clearModelsCache();
  internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
}

export function setupProviderHandlers(deps: ProviderHandlerDeps): void {
  const { messageHub, providerRepo, credentialManager, internalEventBus } = deps;

  /** List all providers with live auth status from the registry. */
  messageHub.onRequest('providers.list', async () => {
    const records = providerRepo.listProviders();
    const registry = getProviderRegistry();
    const enriched = await Promise.all(
      records.map(async (record) => {
        const provider = registry.get(record.providerId);
        const available = provider ? await provider.isAvailable() : false;
        return {
          ...record,
          available,
        };
      })
    );
    return { providers: enriched };
  });

  /** Get a single provider by id. */
  messageHub.onRequest('providers.get', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);
    const provider = getProviderRegistry().get(record.providerId);
    const available = provider ? await provider.isAvailable() : false;
    return { provider: { ...record, available } };
  });

  /** Create a provider, store credentials, and register it. */
  messageHub.onRequest(
    'providers.create',
    async (data: {
      params: CreateProviderParams;
      credentials?: {
        apiKey?: string;
        baseUrl?: string;
        oauthAccessToken?: string;
        oauthRefreshToken?: string;
        oauthExpiresAt?: number;
      };
    }) => {
      const lock =
        data.params.kind === 'custom_endpoint' ? withCustomEndpointsLock : withProviderLock;
      return lock(async () => {
        validateCreateParams(data.params);
        const record = providerRepo.createProvider(data.params);

        try {
          // Store credentials if provided. Custom endpoints keep auth inline in
          // customEndpointConfigJson, so skip the credential store entirely —
          // otherwise a locked macOS Keychain would block creating the endpoint.
          if (record.kind !== 'custom_endpoint') {
            if (data.credentials?.apiKey) {
              await credentialManager.storeApiKey(record.providerId, data.credentials.apiKey);
            } else if (data.credentials?.oauthAccessToken) {
              await credentialManager.storeOAuthTokens(record.providerId, {
                accessToken: data.credentials.oauthAccessToken,
                refreshToken: data.credentials.oauthRefreshToken,
                expiresAt: data.credentials.oauthExpiresAt,
              });
            }
          }

          // Sync to registry.
          if (record.kind === 'built_in') {
            const { ensureBuiltInProviderRegistered } = await import('../providers/factory.js');
            await ensureBuiltInProviderRegistered(record.providerId);
          }
          const creds = await resolveCredentialsForHydration(
            credentialManager,
            record.providerId,
            data.credentials
          );
          await syncProviderToRegistry(record, creds);
        } catch (err) {
          // Compensating delete: remove the orphan DB record so retries don't fail
          // with 'already exists'.
          providerRepo.deleteProvider(record.id);
          rethrowKeychainError(err, 'create', record.providerId);
        }

        await clearCacheAndNotifyProvidersChanged(internalEventBus);

        return { success: true, provider: record };
      });
    }
  );

  /** Update a provider. Re-registers if config changed. */
  messageHub.onRequest(
    'providers.update',
    async (data: {
      id: string;
      params: Partial<UpdateProviderParams>;
      credentials?: {
        apiKey?: string;
        baseUrl?: string;
        oauthAccessToken?: string;
        oauthRefreshToken?: string;
        oauthExpiresAt?: number;
      };
    }) => {
      return withProviderLock(async () => {
        const updates = validateUpdateParams(data.params);
        const existing = providerRepo.getProvider(data.id);
        if (!existing) throw new Error(`Provider ${data.id} not found`);
        const lock =
          existing.kind === 'custom_endpoint'
            ? withCustomEndpointsLock
            : (fn: () => Promise<unknown>) => fn();
        return lock(async () => {
          // Handle credential updates. Custom endpoints keep auth inline, so
          // skip the credential store for them.
          if (data.credentials && existing.kind !== 'custom_endpoint') {
            try {
              if (data.credentials.apiKey) {
                await credentialManager.storeApiKey(existing.providerId, data.credentials.apiKey);
                updates.authType = 'api_key';
              } else if (data.credentials.oauthAccessToken) {
                await credentialManager.storeOAuthTokens(existing.providerId, {
                  accessToken: data.credentials.oauthAccessToken,
                  refreshToken: data.credentials.oauthRefreshToken,
                  expiresAt: data.credentials.oauthExpiresAt,
                });
                updates.authType = 'oauth';
              }
            } catch (err) {
              rethrowKeychainError(err, 'update', existing.providerId);
            }
          }

          const record = providerRepo.updateProvider(data.id, updates);
          if (!record) throw new Error(`Provider ${data.id} not found`);

          // Re-sync to registry if config, credentials, or enabled state changed.
          const shouldResync =
            data.credentials !== undefined ||
            updates.baseUrl !== undefined ||
            updates.customEndpointConfigJson !== undefined ||
            updates.configJson !== undefined ||
            updates.isEnabled !== undefined;

          if (shouldResync) {
            if (record.isEnabled === false) {
              if (record.kind === 'built_in') {
                markBuiltInProviderDisabled(record.providerId);
              }
              await removeProviderFromRegistry(record.providerId);
            } else {
              const { ensureBuiltInProviderRegistered } = await import('../providers/factory.js');
              await ensureBuiltInProviderRegistered(record.providerId);
              const creds = await resolveCredentialsForHydration(
                credentialManager,
                record.providerId,
                data.credentials
              );
              await syncProviderToRegistry(record, creds);
            }
          }

          await clearCacheAndNotifyProvidersChanged(internalEventBus);

          return { success: true, provider: record };
        });
      });
    }
  );

  /** Delete a provider, remove credentials, and unregister. */
  messageHub.onRequest('providers.delete', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);
    const lock = record.kind === 'custom_endpoint' ? withCustomEndpointsLock : withProviderLock;
    return lock(async () => {
      // Custom endpoints store auth inline in customEndpointConfigJson, not in
      // the credential store, so skip keychain cleanup for them — otherwise a
      // locked Keychain would block removing an endpoint that has nothing in
      // the Keychain to clean up.
      if (record.kind !== 'custom_endpoint') {
        try {
          // Keychain-only persistence: remove credentials before deleting provider
          // config. If the Keychain is locked, block deletion so we don't leave a
          // stale credential that can reappear if the provider is re-added.
          await credentialManager.removeCredentials(record.providerId);
        } catch (error) {
          rethrowKeychainError(error, 'delete', record.providerId);
        }
      }

      if (record.kind === 'built_in') {
        // Built-ins cannot be truly deleted; keep the row disabled so the
        // disabled state persists across daemon restarts.
        providerRepo.updateProvider(data.id, { isEnabled: false });
        markBuiltInProviderDisabled(record.providerId);
      } else {
        providerRepo.deleteProvider(data.id);
      }
      await removeProviderFromRegistry(record.providerId);
      await clearCacheAndNotifyProvidersChanged(internalEventBus);
      return { success: true };
    });
  });

  /** Set a provider as the default. */
  messageHub.onRequest('providers.setDefault', async (data: { id: string }) => {
    return withProviderLock(async () => {
      providerRepo.setDefaultProvider(data.id);
      return { success: true };
    });
  });

  /** Test a single provider and update its health_status. */
  messageHub.onRequest('providers.test', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);

    const provider = getProviderRegistry().get(record.providerId);
    if (!provider) {
      providerRepo.updateProvider(data.id, {
        healthStatus: 'unhealthy',
        lastHealthCheckAt: Date.now(),
      });
      return { healthy: false, error: 'Provider not registered' };
    }

    try {
      const available = await provider.isAvailable();
      if (!available) {
        providerRepo.updateProvider(data.id, {
          healthStatus: 'unhealthy',
          lastHealthCheckAt: Date.now(),
        });
        return { healthy: false, error: 'Provider not available' };
      }
      await provider.getModels();
      providerRepo.updateProvider(data.id, {
        healthStatus: 'healthy',
        lastHealthCheckAt: Date.now(),
      });
      return { healthy: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      providerRepo.updateProvider(data.id, {
        healthStatus: 'unhealthy',
        lastHealthCheckAt: Date.now(),
      });
      return { healthy: false, error };
    }
  });

  /** Batch health check for all enabled providers. */
  messageHub.onRequest('providers.healthCheck', async () => {
    const records = providerRepo.listEnabledProviders();
    const registry = getProviderRegistry();
    const results = await Promise.all(
      records.map(async (record) => {
        const provider = registry.get(record.providerId);
        if (!provider) {
          providerRepo.updateProvider(record.id, {
            healthStatus: 'unhealthy',
            lastHealthCheckAt: Date.now(),
          });
          return { providerId: record.providerId, healthy: false, error: 'Not registered' };
        }
        try {
          const available = await provider.isAvailable();
          if (!available) {
            providerRepo.updateProvider(record.id, {
              healthStatus: 'unhealthy',
              lastHealthCheckAt: Date.now(),
            });
            return { providerId: record.providerId, healthy: false, error: 'Not available' };
          }
          await provider.getModels();
          providerRepo.updateProvider(record.id, {
            healthStatus: 'healthy',
            lastHealthCheckAt: Date.now(),
          });
          return { providerId: record.providerId, healthy: true };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          providerRepo.updateProvider(record.id, {
            healthStatus: 'unhealthy',
            lastHealthCheckAt: Date.now(),
          });
          return { providerId: record.providerId, healthy: false, error };
        }
      })
    );
    return { results };
  });
}
