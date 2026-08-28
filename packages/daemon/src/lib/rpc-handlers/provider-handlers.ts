import type { MessageHub } from '@hyperneo/shared';
import { VOICE_CREDENTIAL_PROVIDER_ID } from './settings-handlers.ts';
import type { CreateProviderParams, ProviderRecord, UpdateProviderParams } from '@hyperneo/shared';
import type { ListRemoteModelsOptions, ProviderCredentials } from '@hyperneo/shared/provider';
import type { ProviderRepository } from '../../storage/repositories/provider-repository.ts';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import {
  KEYCHAIN_UNAVAILABLE_MESSAGE,
  KeychainUnavailableError,
} from '../credentials/credential-store.js';
import {
  parseProviderConfig,
  syncProviderToRegistry,
  removeProviderFromRegistry,
} from '../providers/provider-sync.js';
import { getProviderRegistry } from '../providers/registry.js';
import { markBuiltInProviderDisabled } from '../providers/factory.js';
import { AcpProvider } from '../providers/acp-provider.js';
import { fetchAcpModels } from '../acp/acp-model-fetcher.js';
import { parseAcpCommand } from '../acp/acp-command.js';
import { withCustomEndpointsLock } from './custom-endpoint-handlers.js';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { clearCacheAndNotifyProvidersChanged } from './auth-handlers.ts';
import { withProviderLock } from './provider-mutation-lock.ts';
import { Logger } from '../logger.ts';

const log = new Logger('provider-handlers');

const VALID_PROVIDER_KINDS = new Set(['built_in', 'custom_endpoint']);
const VALID_AUTH_TYPES = new Set(['api_key', 'oauth', 'none']);
const VALID_REMOTE_MODEL_OPTIONS = new Set(['force', 'command', 'baseUrl']);

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

type RequestCredentials = {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: number;
};

export async function resolveCredentialsForHydration(
  credentialManager: ProviderCredentialManager,
  providerId: string,
  requestCreds: RequestCredentials | undefined
): Promise<ProviderCredentials | null> {
  if (requestCreds?.apiKey) {
    return { type: 'api_key', apiKey: requestCreds.apiKey };
  }
  if (requestCreds?.oauthAccessToken) {
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
  const provider = getProviderRegistry().get(providerId);
  if (provider?.getCredentials) {
    const live = await provider.getCredentials();
    if (live) return live;
  }
  return credentialManager.getCredentials(providerId);
}

function rethrowKeychainError(err: unknown, action: string, providerId: string): never {
  if (err instanceof KeychainUnavailableError) {
    log.warn(`Provider ${action} blocked for ${providerId}: ${KEYCHAIN_UNAVAILABLE_MESSAGE}`);
    throw new Error(KEYCHAIN_UNAVAILABLE_MESSAGE);
  }
  throw err;
}

function validateAcpConfigCommand(configJson: string | undefined): void {
  if (!configJson) return;
  let parsed: { command?: unknown };
  try {
    parsed = JSON.parse(configJson) as { command?: unknown };
  } catch {
    throw new Error('Invalid ACP config JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid ACP config JSON');
  if (parsed.command === undefined) return;
  if (typeof parsed.command !== 'string') throw new Error('ACP command must be a string');
  if (!parsed.command.trim()) throw new Error('ACP command is required');
  parseAcpCommand(parsed.command);
}

function normalizeRemoteModelOptions(value: unknown): ListRemoteModelsOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote model options must be an object');
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !VALID_REMOTE_MODEL_OPTIONS.has(key));
  if (unknown) throw new Error(`Unknown remote model option: ${unknown}`);
  const options: ListRemoteModelsOptions = {};
  if (input.force !== undefined) {
    if (typeof input.force !== 'boolean') throw new Error('force must be a boolean');
    options.force = input.force;
  }
  if (input.command !== undefined) {
    if (typeof input.command !== 'string') throw new Error('ACP command must be a string');
    if (!input.command.trim() && input.command !== '') throw new Error('ACP command is required');
    const command = input.command.trim();
    if (command.length > MAX_JSON_FIELD_LEN) {
      throw new Error(`ACP command must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
    }
    options.command = command;
  }
  if (input.baseUrl !== undefined) {
    if (typeof input.baseUrl !== 'string') throw new Error('baseUrl must be a string');
    const baseUrl = input.baseUrl.trim();
    if (baseUrl.length > MAX_BASE_URL_LEN) {
      throw new Error(`baseUrl must be ≤ ${MAX_BASE_URL_LEN} chars`);
    }
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('Invalid baseUrl');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('baseUrl must use http:// or https://');
    }
    options.baseUrl = baseUrl;
  }
  return options;
}

type RemoteModel = { id: string; name?: string };
type RemoteModelRequest = { id: string; options: unknown };

function validateRemoteModelRequest(data: unknown): RemoteModelRequest {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid remote model request');
  }
  const input = data as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => key !== 'id' && key !== 'options');
  if (unknown) throw new Error(`Unknown remote model request field: ${unknown}`);
  if (typeof input.id !== 'string' || !input.id.trim()) {
    throw new Error('Provider id is required');
  }
  return { id: input.id, options: input.options };
}

async function listAcpRemoteModels(
  record: ProviderRecord,
  options: ListRemoteModelsOptions
): Promise<RemoteModel[]> {
  if (record.providerId !== 'acp') {
    throw new Error(`Provider ${record.id} is not an ACP provider`);
  }
  if (options.baseUrl !== undefined) {
    throw new Error('baseUrl is not supported for ACP providers');
  }
  const useEnvCommand = options.command === '';
  const registered = getProviderRegistry().get('acp');
  const provider =
    registered instanceof AcpProvider && !useEnvCommand ? registered : new AcpProvider();
  if (!(registered instanceof AcpProvider) && !useEnvCommand) {
    provider.setAcpCommand(parseProviderConfig(record.configJson).command);
  }
  return fetchAcpModels(provider, { command: options.command || undefined });
}

export interface ProviderHandlerDeps {
  messageHub: MessageHub;
  providerRepo: ProviderRepository;
  credentialManager: ProviderCredentialManager;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
}

function notifyProvidersChanged(internalEventBus: InternalEventBus<DaemonInternalEventMap>): void {
  internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
}

export function setupProviderHandlers(deps: ProviderHandlerDeps): void {
  const { messageHub, providerRepo, credentialManager, internalEventBus } = deps;

  messageHub.onRequest('providers.list', async () => {
    const records = providerRepo.listProviders();
    const registry = getProviderRegistry();
    const enriched = await Promise.all(
      records.map(async (record) => {
        const provider = registry.get(record.providerId);
        if (!provider) return { ...record, available: false };
        try {
          return { ...record, available: await provider.isAvailable() };
        } catch (error) {
          log.error(`Failed to check availability for ${record.providerId}:`, error);
          return { ...record, available: false };
        }
      })
    );
    return { providers: enriched };
  });

  messageHub.onRequest('providers.get', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);
    const provider = getProviderRegistry().get(record.providerId);
    const available = provider ? await provider.isAvailable() : false;
    return { provider: { ...record, available } };
  });

  messageHub.onRequest('providers.listRemoteModels', async (data: unknown) => {
    const request = validateRemoteModelRequest(data);
    const record = providerRepo.getProvider(request.id);
    if (!record) throw new Error(`Provider ${request.id} not found`);
    const options = normalizeRemoteModelOptions(request.options);
    let models: RemoteModel[];
    if (record.providerId === 'acp') {
      models = await listAcpRemoteModels(record, options);
    } else {
      if (options.command !== undefined) {
        throw new Error('command is only supported for ACP providers');
      }
      const provider = getProviderRegistry().get(record.providerId);
      if (!provider) throw new Error(`Provider ${record.providerId} is not registered`);
      if (!provider.listRemoteModels) {
        throw new Error(`Provider ${record.providerId} does not support remote model listing`);
      }
      models = await provider.listRemoteModels(options);
    }
    return {
      models: models.map(({ id, name }) => ({ id, ...(name === undefined ? {} : { name }) })),
    };
  });

  messageHub.onRequest(
    'providers.fetchAcpModels',
    async (data: { id: string; command?: string }) => {
      const record = providerRepo.getProvider(data.id);
      if (!record) throw new Error(`Provider ${data.id} not found`);
      if (record.providerId !== 'acp') {
        throw new Error(`Provider ${data.id} is not an ACP provider`);
      }
      const options = normalizeRemoteModelOptions({ command: data.command });
      return { models: await listAcpRemoteModels(record, options) };
    }
  );

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
        if (data.params.providerId === 'acp') {
          validateAcpConfigCommand(data.params.configJson);
        }
        const record = providerRepo.createProvider(data.params);

        try {
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

          if (record.isEnabled) {
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
          } else if (record.kind === 'built_in') {
            markBuiltInProviderDisabled(record.providerId);
            await removeProviderFromRegistry(record.providerId, { preserveCredentials: true });
          }
        } catch (err) {
          providerRepo.deleteProvider(record.id);
          rethrowKeychainError(err, 'create', record.providerId);
        }

        await clearCacheAndNotifyProvidersChanged(internalEventBus);

        return { success: true, provider: record };
      });
    }
  );

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
        if (existing.providerId === VOICE_CREDENTIAL_PROVIDER_ID)
          throw new Error(`providerId '${VOICE_CREDENTIAL_PROVIDER_ID}' is reserved`);
        if (existing.providerId === 'acp' && updates.configJson !== undefined) {
          validateAcpConfigCommand(updates.configJson);
        }
        const lock =
          existing.kind === 'custom_endpoint'
            ? withCustomEndpointsLock
            : (fn: () => Promise<unknown>) => fn();
        return lock(async () => {
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

          let record: ProviderRecord | null = null;
          try {
            record = providerRepo.updateProvider(data.id, updates);
            if (!record) throw new Error(`Provider ${data.id} not found`);

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
                await removeProviderFromRegistry(record.providerId, { preserveCredentials: true });
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
          } catch (error) {
            if (data.credentials && existing.kind !== 'custom_endpoint') {
              try {
                await clearCacheAndNotifyProvidersChanged(
                  internalEventBus,
                  record?.providerId ?? existing.providerId,
                  providerRepo
                );
              } catch (stripError) {
                log.error(
                  `Failed to clear cache after update error for ${existing.providerId}:`,
                  stripError
                );
              }
            }
            throw error;
          }

          if (!record) throw new Error(`Provider ${data.id} not found`);

          if (data.credentials && existing.kind !== 'custom_endpoint') {
            await clearCacheAndNotifyProvidersChanged(
              internalEventBus,
              record.providerId,
              providerRepo
            );
          } else {
            await clearCacheAndNotifyProvidersChanged(internalEventBus);
          }

          const finalRecord = providerRepo.getProvider(record.id);
          if (!finalRecord) throw new Error(`Provider ${data.id} not found`);
          return { success: true, provider: finalRecord };
        });
      });
    }
  );

  messageHub.onRequest('providers.delete', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);
    if (record.providerId === VOICE_CREDENTIAL_PROVIDER_ID)
      throw new Error(`providerId '${VOICE_CREDENTIAL_PROVIDER_ID}' is reserved`);
    const lock = record.kind === 'custom_endpoint' ? withCustomEndpointsLock : withProviderLock;
    return lock(async () => {
      if (record.kind !== 'custom_endpoint') {
        try {
          await credentialManager.removeCredentials(record.providerId);
        } catch (error) {
          rethrowKeychainError(error, 'delete', record.providerId);
        }
      }

      if (record.kind === 'built_in') {
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

  messageHub.onRequest('providers.setDefault', async (data: { id: string }) => {
    return withProviderLock(async () => {
      providerRepo.setDefaultProvider(data.id);
      notifyProvidersChanged(internalEventBus);
      return { success: true };
    });
  });

  messageHub.onRequest('providers.test', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);

    const provider = getProviderRegistry().get(record.providerId);
    if (!provider) {
      providerRepo.updateProvider(data.id, {
        healthStatus: 'unhealthy',
        lastHealthCheckAt: Date.now(),
      });
      notifyProvidersChanged(internalEventBus);
      return { healthy: false, error: 'Provider not registered' };
    }

    try {
      const available = await provider.isAvailable();
      if (!available) {
        providerRepo.updateProvider(data.id, {
          healthStatus: 'unhealthy',
          lastHealthCheckAt: Date.now(),
        });
        notifyProvidersChanged(internalEventBus);
        return { healthy: false, error: 'Provider not available' };
      }
      if (provider instanceof AcpProvider) {
        await provider.verifyCommandAvailable({ force: true });
      }
      await provider.getModels();
      providerRepo.updateProvider(data.id, {
        healthStatus: 'healthy',
        lastHealthCheckAt: Date.now(),
      });
      notifyProvidersChanged(internalEventBus);
      return { healthy: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      providerRepo.updateProvider(data.id, {
        healthStatus: 'unhealthy',
        lastHealthCheckAt: Date.now(),
      });
      notifyProvidersChanged(internalEventBus);
      return { healthy: false, error };
    }
  });

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
          if (provider instanceof AcpProvider) {
            await provider.verifyCommandAvailable();
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
    notifyProvidersChanged(internalEventBus);
    return { results };
  });
}
