/**
 * Provider RPC Handlers
 *
 * Unified CRUD for the providers table. Bridges persistence, credential storage,
 * and the live ProviderRegistry so changes take effect immediately.
 */

import type { MessageHub } from '@neokai/shared';
import type { CreateProviderParams, UpdateProviderParams } from '@neokai/shared';
import type { ProviderRepository } from '../../storage/repositories/provider-repository';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager';
import { syncProviderToRegistry, removeProviderFromRegistry } from '../providers/provider-sync.js';
import { getProviderRegistry } from '../providers/registry.js';

const VALID_PROVIDER_KINDS = new Set(['built_in', 'custom_endpoint']);
const VALID_AUTH_TYPES = new Set(['api_key', 'oauth', 'none']);

function validateCreateParams(params: unknown): asserts params is CreateProviderParams {
  if (!params || typeof params !== 'object') throw new Error('Invalid provider params');
  const p = params as Record<string, unknown>;
  if (!p.providerId || typeof p.providerId !== 'string') throw new Error('providerId is required');
  if (!p.displayName || typeof p.displayName !== 'string')
    throw new Error('displayName is required');
  const kind = typeof p.kind === 'string' ? p.kind : '';
  if (!VALID_PROVIDER_KINDS.has(kind))
    throw new Error(`kind must be one of: ${[...VALID_PROVIDER_KINDS].join(', ')}`);
  const authType = typeof p.authType === 'string' ? p.authType : '';
  if (!VALID_AUTH_TYPES.has(authType))
    throw new Error(`authType must be one of: ${[...VALID_AUTH_TYPES].join(', ')}`);
}

function validateUpdateParams(params: unknown): Partial<UpdateProviderParams> {
  if (!params || typeof params !== 'object') throw new Error('Invalid provider update params');
  const p = params as Record<string, unknown>;
  const out: Partial<UpdateProviderParams> = {};
  if (p.displayName !== undefined) {
    if (typeof p.displayName !== 'string') throw new Error('displayName must be a string');
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
  if ('baseUrl' in p) out.baseUrl = p.baseUrl === undefined ? undefined : String(p.baseUrl);
  if ('configJson' in p)
    out.configJson = p.configJson === undefined ? undefined : String(p.configJson);
  if ('customEndpointConfigJson' in p)
    out.customEndpointConfigJson =
      p.customEndpointConfigJson === undefined ? undefined : String(p.customEndpointConfigJson);
  return out;
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

// ---------------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------------

export interface ProviderHandlerDeps {
  messageHub: MessageHub;
  providerRepo: ProviderRepository;
  credentialManager: ProviderCredentialManager;
}

export function setupProviderHandlers(deps: ProviderHandlerDeps): void {
  const { messageHub, providerRepo, credentialManager } = deps;

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
      return withProviderLock(async () => {
        validateCreateParams(data.params);
        const record = providerRepo.createProvider(data.params);

        // Store credentials if provided.
        if (data.credentials?.apiKey) {
          await credentialManager.storeApiKey(record.providerId, data.credentials.apiKey);
        } else if (data.credentials?.oauthAccessToken) {
          await credentialManager.storeOAuthTokens(record.providerId, {
            accessToken: data.credentials.oauthAccessToken,
            refreshToken: data.credentials.oauthRefreshToken,
            expiresAt: data.credentials.oauthExpiresAt,
          });
        }

        // Sync to registry.
        const creds = await credentialManager.getCredentials(record.providerId);
        await syncProviderToRegistry(record, creds);

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

        // Handle credential updates.
        if (data.credentials) {
          if (data.credentials.apiKey) {
            await credentialManager.storeApiKey(existing.providerId, data.credentials.apiKey);
            updates.authType = 'api_key';
          } else if (data.credentials.oauthAccessToken) {
            await credentialManager.storeOAuthTokens(existing.providerId, {
              oauthAccessToken: data.credentials.oauthAccessToken,
              oauthRefreshToken: data.credentials.oauthRefreshToken,
              oauthExpiresAt: data.credentials.oauthExpiresAt,
            });
            updates.authType = 'oauth';
          }
        }

        const record = providerRepo.updateProvider(data.id, updates);
        if (!record) throw new Error(`Provider ${data.id} not found`);

        // Re-sync to registry if config or credentials changed.
        const shouldResync =
          data.credentials !== undefined ||
          updates.baseUrl !== undefined ||
          updates.customEndpointConfigJson !== undefined ||
          updates.configJson !== undefined;

        if (shouldResync) {
          const creds = await credentialManager.getCredentials(record.providerId);
          await syncProviderToRegistry(record, creds);
        }

        return { success: true, provider: record };
      });
    }
  );

  /** Delete a provider, remove credentials, and unregister. */
  messageHub.onRequest('providers.delete', async (data: { id: string }) => {
    return withProviderLock(async () => {
      const record = providerRepo.getProvider(data.id);
      if (!record) throw new Error(`Provider ${data.id} not found`);

      await removeProviderFromRegistry(record.providerId);
      await credentialManager.removeCredentials(record.providerId);
      providerRepo.deleteProvider(data.id);

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
