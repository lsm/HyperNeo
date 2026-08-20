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
import { AcpProvider } from '../providers/acp-provider.js';
import { disposeAcpSessions, fetchAcpModels } from '../acp/acp-model-fetcher.js';
import { getAcpCommandIdentity, parseAcpCommand } from '../acp/acp-command.js';
import { withCustomEndpointsLock } from './custom-endpoint-handlers.js';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SessionManager } from '../session/session-manager';
import { Logger } from '../logger';

const log = new Logger('provider-handlers');

const VALID_PROVIDER_KINDS = new Set(['built_in', 'custom_endpoint']);
const VALID_AUTH_TYPES = new Set(['api_key', 'oauth', 'none']);

const MAX_PROVIDER_ID_LEN = 128;
const MAX_DISPLAY_NAME_LEN = 256;
const MAX_BASE_URL_LEN = 2048;
const MAX_JSON_FIELD_LEN = 64 * 1024;
const ACP_DISPOSE_TIMEOUT_MS = 30_000;

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

let mutationQueue: Promise<unknown> = Promise.resolve();

function withProviderLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

function rethrowKeychainError(err: unknown, action: string, providerId: string): never {
  if (err instanceof KeychainUnavailableError) {
    log.warn(`Provider ${action} blocked for ${providerId}: ${KEYCHAIN_UNAVAILABLE_MESSAGE}`);
    throw new Error(KEYCHAIN_UNAVAILABLE_MESSAGE);
  }
  throw err;
}

export interface ProviderHandlerDeps {
  messageHub: MessageHub;
  providerRepo: ProviderRepository;
  credentialManager: ProviderCredentialManager;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  sessionManager?: Pick<
    SessionManager,
    'interruptCachedProviderSessions' | 'interruptProviderSessions'
  >;
  clearPersistedAcpSessionIds?: () => void;
  listPersistedAcpSessionIds?: () => Array<{ sessionId: string; acpSessionId: string }>;
  disposeAcpSessions?: typeof disposeAcpSessions;
}

function readAcpCommand(configJson: string | undefined): string | undefined {
  if (!configJson) return undefined;
  try {
    const parsed = JSON.parse(configJson) as { command?: unknown };
    return typeof parsed.command === 'string' ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}

function validateAcpConfigCommand(configJson: string | undefined): string | undefined {
  if (!configJson) return undefined;
  let parsed: { command?: unknown };
  try {
    parsed = JSON.parse(configJson) as { command?: unknown };
  } catch {
    throw new Error('Invalid ACP config JSON');
  }
  if (parsed.command === undefined) return undefined;
  if (typeof parsed.command !== 'string') throw new Error('ACP command must be a string');
  if (!parsed.command.trim()) throw new Error('ACP command is required');
  parseAcpCommand(parsed.command);
  return parsed.command;
}

async function disposeAcpSessionIds(
  previousCommand: string | undefined,
  sessionIds: string[],
  dispose: typeof disposeAcpSessions = disposeAcpSessions
): Promise<void> {
  if (!previousCommand || sessionIds.length === 0) return;
  const disposeController = new AbortController();
  const disposeTimer = setTimeout(() => disposeController.abort(), ACP_DISPOSE_TIMEOUT_MS);
  disposeTimer.unref();
  await dispose(previousCommand, sessionIds, undefined, disposeController.signal).catch(() => {});
  clearTimeout(disposeTimer);
}

async function invalidateAcpSessions(
  sessionManager: Pick<SessionManager, 'interruptProviderSessions'> | undefined,
  clearPersistedAcpSessionIds: (() => void) | undefined,
  previousCommand: string | undefined,
  listPersistedAcpSessionIds?: () => Array<{ sessionId: string; acpSessionId: string }>,
  dispose: typeof disposeAcpSessions = disposeAcpSessions
): Promise<void> {
  const sessionIds = listPersistedAcpSessionIds?.().map((entry) => entry.acpSessionId) ?? [];
  clearPersistedAcpSessionIds?.();
  await disposeAcpSessionIds(previousCommand, sessionIds, dispose);
  await sessionManager?.interruptProviderSessions('acp');
}

function acpCommandsDiffer(
  previousCommand: string | undefined,
  nextCommand: string | undefined
): boolean {
  if (!previousCommand || !nextCommand) return previousCommand !== nextCommand;
  try {
    return getAcpCommandIdentity(previousCommand) !== getAcpCommandIdentity(nextCommand);
  } catch {
    return previousCommand !== nextCommand;
  }
}

async function clearCacheAndNotifyProvidersChanged(
  internalEventBus: InternalEventBus<DaemonInternalEventMap>
): Promise<void> {
  const { clearModelsCache } = await import('../model-service.js');
  clearModelsCache();
  internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
}

export function setupProviderHandlers(deps: ProviderHandlerDeps): void {
  const {
    messageHub,
    providerRepo,
    credentialManager,
    internalEventBus,
    sessionManager,
    clearPersistedAcpSessionIds,
    listPersistedAcpSessionIds,
    disposeAcpSessions: disposeAcpSessionsOverride,
  } = deps;

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

  messageHub.onRequest('providers.get', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);
    const provider = getProviderRegistry().get(record.providerId);
    const available = provider ? await provider.isAvailable() : false;
    return { provider: { ...record, available } };
  });

  messageHub.onRequest(
    'providers.fetchAcpModels',
    async (data: { id: string; command?: string }) => {
      const record = providerRepo.getProvider(data.id);
      if (!record) throw new Error(`Provider ${data.id} not found`);
      if (record.providerId !== 'acp')
        throw new Error(`Provider ${data.id} is not an ACP provider`);
      if (data.command !== undefined) {
        if (typeof data.command !== 'string') throw new Error('ACP command must be a string');
        if (!data.command.trim()) throw new Error('ACP command is required');
        if (data.command.length > MAX_JSON_FIELD_LEN)
          throw new Error(`ACP command must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
      }
      const registered = getProviderRegistry().get('acp');
      const provider = registered instanceof AcpProvider ? registered : new AcpProvider();
      const models = await fetchAcpModels(provider, { command: data.command });
      return { models };
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
        const newAcpCommand =
          data.params.providerId === 'acp'
            ? validateAcpConfigCommand(data.params.configJson)
            : undefined;
        const registeredAcpProvider = getProviderRegistry().get('acp');
        const previousAcpCommand =
          data.params.providerId === 'acp'
            ? registeredAcpProvider instanceof AcpProvider
              ? registeredAcpProvider.getAcpCommand()
              : process.env.HYPERNEO_ACP_COMMAND
            : undefined;
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
            if (
              newAcpCommand !== undefined &&
              acpCommandsDiffer(previousAcpCommand, newAcpCommand)
            ) {
              await invalidateAcpSessions(
                sessionManager,
                clearPersistedAcpSessionIds,
                previousAcpCommand,
                listPersistedAcpSessionIds,
                disposeAcpSessionsOverride
              );
            }
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

          const updatedAcpCommand =
            existing.providerId === 'acp' && updates.configJson !== undefined
              ? validateAcpConfigCommand(updates.configJson)
              : undefined;
          const registeredAcpProvider = getProviderRegistry().get('acp');
          const liveAcpCommand =
            registeredAcpProvider instanceof AcpProvider
              ? registeredAcpProvider.getAcpCommand()
              : process.env.HYPERNEO_ACP_COMMAND;
          const effectiveAcpCommandBeforeEnable =
            readAcpCommand(existing.configJson) ?? liveAcpCommand;
          const enablingChangedAcpCommand =
            existing.providerId === 'acp' &&
            existing.isEnabled === false &&
            updates.isEnabled === true &&
            updates.configJson !== undefined &&
            acpCommandsDiffer(effectiveAcpCommandBeforeEnable, updatedAcpCommand);
          const envAcpCommand = process.env.HYPERNEO_ACP_COMMAND;
          const acpCommandChanged =
            existing.providerId === 'acp' &&
            updates.configJson !== undefined &&
            acpCommandsDiffer(effectiveAcpCommandBeforeEnable, updatedAcpCommand ?? envAcpCommand);
          const record = providerRepo.updateProvider(data.id, updates);
          if (!record) throw new Error(`Provider ${data.id} not found`);
          const shouldInvalidateAcpSessions =
            (acpCommandChanged || enablingChangedAcpCommand) &&
            !(acpCommandChanged && existing.isEnabled === false && updates.isEnabled !== true);
          if (acpCommandChanged && existing.isEnabled === false && updates.isEnabled !== true) {
            const sessionIds =
              listPersistedAcpSessionIds?.().map((entry) => entry.acpSessionId) ?? [];
            clearPersistedAcpSessionIds?.();
            await disposeAcpSessionIds(
              effectiveAcpCommandBeforeEnable,
              sessionIds,
              disposeAcpSessionsOverride
            );
          }

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
              if (record.providerId === 'acp' && existing.isEnabled !== false) {
                await sessionManager?.interruptCachedProviderSessions('acp');
              }
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

          if (shouldInvalidateAcpSessions) {
            await invalidateAcpSessions(
              sessionManager,
              clearPersistedAcpSessionIds,
              effectiveAcpCommandBeforeEnable,
              listPersistedAcpSessionIds,
              disposeAcpSessionsOverride
            );
          }

          await clearCacheAndNotifyProvidersChanged(internalEventBus);

          return { success: true, provider: record };
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
        await removeProviderFromRegistry(record.providerId);
        if (record.providerId === 'acp' && record.isEnabled !== false) {
          await sessionManager?.interruptCachedProviderSessions('acp');
        }
      } else {
        providerRepo.deleteProvider(data.id);
        await removeProviderFromRegistry(record.providerId);
      }
      await clearCacheAndNotifyProvidersChanged(internalEventBus);
      return { success: true };
    });
  });

  messageHub.onRequest('providers.setDefault', async (data: { id: string }) => {
    return withProviderLock(async () => {
      providerRepo.setDefaultProvider(data.id);
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
      if (provider instanceof AcpProvider) {
        await provider.verifyCommandAvailable();
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
    return { results };
  });
}
