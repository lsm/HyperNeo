import superpipe, { type PipelineAPI } from 'superpipe';
import type { MessageHub, ProviderRecord } from '@hyperneo/shared';
import type {
  ProviderAuthStatus,
  ProviderAuthResponse,
  ProviderAuthRequest,
  ProviderLogoutRequest,
  ProviderLogoutResponse,
  ProviderRefreshRequest,
  ProviderRefreshResponse,
  ListProviderAuthStatusResponse,
  ProviderCredentials,
} from '@hyperneo/shared/provider';
import type { AuthManager } from '../auth-manager.ts';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import {
  KEYCHAIN_UNAVAILABLE_MESSAGE,
  KeychainUnavailableError,
} from '../credentials/credential-store.js';
import { getProviderRegistry } from '../providers/registry.ts';
import { bumpProviderCatalogEpoch } from '../model-service.js';
import { providerEnvCoordinator } from '../providers/provider-env-enrollment.ts';
import { registerBuiltInProvider } from '../providers/factory.js';
import {
  credentialIdentity,
  stripPersistedDiscovery,
} from '../providers/discovery-refresh-pipeline.ts';
import type { ProviderRepository } from '../../storage/repositories/provider-repository.ts';
import {
  applyRecordedFailureToAuthStatus,
  classifyProviderFailure,
} from '../providers/provider-failure-store.js';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
const log = new Logger('auth-handlers');

type ClearCacheCtx = {
  internalEventBus: InternalEventBus<DaemonInternalEventMap> | undefined;
  providerId?: string;
  providerRepo?: ProviderRepository;
  stripPersisted: boolean;
  record?: ProviderRecord | null;
  stripped?: string;
  readError?: unknown;
  stripError?: unknown;
};

function clearCacheLoadRecord(ctx: ClearCacheCtx): ClearCacheCtx {
  if (ctx.providerId && ctx.providerRepo && ctx.stripPersisted) {
    try {
      ctx.record = ctx.providerRepo.getProviderByProviderId(ctx.providerId);
    } catch (error) {
      ctx.readError = error;
    }
  }
  return ctx;
}

function clearCacheStripRecord(ctx: ClearCacheCtx): ClearCacheCtx {
  if (ctx.record) {
    ctx.stripped = stripPersistedDiscovery(ctx.record.configJson);
    if (ctx.stripped !== ctx.record.configJson) {
      try {
        ctx.providerRepo!.updateProvider(ctx.record.id, { configJson: ctx.stripped });
      } catch (error) {
        ctx.stripError = error;
      }
    }
  }
  return ctx;
}

async function clearCacheInvalidate(ctx: ClearCacheCtx): Promise<ClearCacheCtx> {
  const { clearModelsCache } = await import('../model-service.js');
  clearModelsCache(undefined, ctx.providerId);
  return ctx;
}

function clearCachePublishChanged(ctx: ClearCacheCtx): ClearCacheCtx {
  ctx.internalEventBus?.publishAsync('providers.changed', { sessionId: 'global' });
  return ctx;
}

function clearCacheRethrowIfNeeded(ctx: ClearCacheCtx): ClearCacheCtx {
  if (ctx.readError) throw ctx.readError;
  if (ctx.stripError) throw ctx.stripError;
  return ctx;
}

const runClearCacheAndNotifyProvidersChanged = (
  superpipe({})('clear-cache-and-notify-providers-changed') as PipelineAPI
)
  .input(['ctx'])
  .pipe(clearCacheLoadRecord, 'ctx', 'ctx')
  .pipe(clearCacheStripRecord, 'ctx', 'ctx')
  .pipe(clearCacheInvalidate, 'ctx', 'ctx')
  .pipe(clearCachePublishChanged, 'ctx', 'ctx')
  .pipe(clearCacheRethrowIfNeeded, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: ClearCacheCtx) => Promise<ClearCacheCtx>;

export async function clearCacheAndNotifyProvidersChanged(
  internalEventBus: InternalEventBus<DaemonInternalEventMap> | undefined,
  providerId?: string,
  providerRepo?: ProviderRepository,
  stripPersisted = true
): Promise<void> {
  await runClearCacheAndNotifyProvidersChanged({
    internalEventBus,
    providerId,
    providerRepo,
    stripPersisted,
  });
}

async function removeCredentialsOrKeychainError(
  credentialManager: ProviderCredentialManager | undefined,
  providerId: string
): Promise<void> {
  if (!credentialManager) return;
  try {
    await credentialManager.removeCredentials(providerId);
  } catch (error) {
    if (error instanceof KeychainUnavailableError) {
      log.warn(`Logout blocked for ${providerId}: ${KEYCHAIN_UNAVAILABLE_MESSAGE}`);
      throw new KeychainUnavailableError(KEYCHAIN_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

export function setupAuthHandlers(
  messageHub: MessageHub,
  authManager: AuthManager,
  credentialManager?: ProviderCredentialManager,
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>,
  providerRepo?: ProviderRepository
): void {
  messageHub.onRequest('auth.status', async () => {
    const authStatus = await authManager.getAuthStatus();
    return { authStatus };
  });

  messageHub.onRequest('auth.providers', async (): Promise<ListProviderAuthStatusResponse> => {
    const registry = getProviderRegistry();
    const providers = registry.getAll();

    const providerStatuses: ProviderAuthStatus[] = await Promise.all(
      providers.map(async (provider) => {
        let authStatus: ProviderAuthStatus = {
          id: provider.id,
          displayName: provider.displayName,
          isAuthenticated: false,
        };

        try {
          if (provider.getAuthStatus) {
            const status = await provider.getAuthStatus();
            authStatus = {
              id: provider.id,
              displayName: provider.displayName,
              isAuthenticated: status.isAuthenticated,
              method: status.method,
              expiresAt: status.expiresAt,
              needsRefresh: status.needsRefresh,
              user: status.user,
              error: status.error,
              errorKind: status.errorKind,
            };
          } else {
            const available = await provider.isAvailable();
            authStatus = {
              id: provider.id,
              displayName: provider.displayName,
              isAuthenticated: available,
            };
          }
        } catch (error) {
          log.error(`Failed to get auth status for ${provider.id}:`, error);
          const failure = classifyProviderFailure(error);
          authStatus = {
            id: provider.id,
            displayName: provider.displayName,
            isAuthenticated: false,
            error: failure.message,
            errorKind: failure.errorKind,
          };
        }

        return {
          ...authStatus,
          ...applyRecordedFailureToAuthStatus(provider.id, authStatus),
        };
      })
    );

    return { providers: providerStatuses };
  });

  messageHub.onRequest(
    'auth.login',
    async (req: ProviderAuthRequest): Promise<ProviderAuthResponse> => {
      const { providerId } = req;
      const registry = getProviderRegistry();
      await registerBuiltInProvider(registry, providerId);

      const provider = registry.get(providerId);
      if (!provider) {
        return {
          success: false,
          error: `Provider not found: ${providerId}`,
        };
      }

      if (!provider.startOAuthFlow) {
        return {
          success: false,
          error: `Provider ${providerId} does not support OAuth login`,
        };
      }

      try {
        let unsubscribe: (() => void) | undefined;
        const persistCredentials = async (credentials: ProviderCredentials): Promise<void> => {
          bumpProviderCatalogEpoch(providerId);
          let storeError: unknown;
          if (credentials.type === 'oauth') {
            try {
              await credentialManager?.storeOAuthTokens(providerId, credentials);
            } catch (error) {
              storeError = error;
            }
          }
          unsubscribe?.();
          let stripError: unknown;
          try {
            await clearCacheAndNotifyProvidersChanged(internalEventBus, providerId, providerRepo);
          } catch (error) {
            stripError = error;
          }
          if (storeError) throw storeError;
          if (stripError) throw stripError;
        };
        unsubscribe = provider.onCredentialsChanged?.((credentials) =>
          persistCredentials(credentials).catch((error) => {
            log.error(`Failed to persist credentials for ${providerId}:`, error);
          })
        );
        const flowData = await provider.startOAuthFlow();
        if (!provider.onCredentialsChanged) {
          const credentials = await provider.getCredentials?.();
          if (credentials) {
            await persistCredentials(credentials);
          }
        }

        return {
          success: true,
          authUrl: flowData.authUrl,
          userCode: flowData.userCode,
          verificationUri: flowData.verificationUri,
          message: flowData.message,
        };
      } catch (error) {
        log.error(`OAuth login failed for ${providerId}:`, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'OAuth login failed',
        };
      }
    }
  );

  messageHub.onRequest(
    'auth.logout',
    async (req: ProviderLogoutRequest): Promise<ProviderLogoutResponse> => {
      const { providerId } = req;
      const registry = getProviderRegistry();

      const provider = registry.get(providerId);
      if (!provider) {
        return {
          success: false,
          error: `Provider not found: ${providerId}`,
        };
      }

      try {
        bumpProviderCatalogEpoch(providerId);
        const hasEnvironmentCredentials = await providerEnvCoordinator.runWithLease(
          'provider-credential-manager.hasEnvironmentCredentials',
          () => credentialManager?.hasEnvironmentCredentials(providerId) ?? false
        );
        if (!provider.logout && hasEnvironmentCredentials) {
          await removeCredentialsOrKeychainError(credentialManager, providerId);
          return {
            success: false,
            error: `Provider ${providerId} credentials are managed by environment variables. Remove the environment variable to log out.`,
          };
        }

        let storedCredentials: ProviderCredentials | null = null;
        try {
          storedCredentials = (await credentialManager?.getCredentials(providerId)) ?? null;
        } catch (readError) {
          await removeCredentialsOrKeychainError(credentialManager, providerId);
          if (provider.logout) {
            try {
              await provider.logout();
            } catch (logoutError) {
              log.error(`Provider logout failed for ${providerId}:`, logoutError);
            }
          }
          try {
            await clearCacheAndNotifyProvidersChanged(internalEventBus, providerId, providerRepo);
          } catch {}
          log.error(`Logout failed for ${providerId}:`, readError);
          return {
            success: false,
            error: readError instanceof Error ? readError.message : 'Logout failed',
          };
        }

        if (!provider.logout && !storedCredentials) {
          const backend = credentialManager?.getCredentialStoreStatus?.().backend;
          const keychainLocked =
            backend === 'keychain-unavailable' || backend === 'keychain-fallback';
          if (keychainLocked) {
            await removeCredentialsOrKeychainError(credentialManager, providerId);
          }
          return {
            success: false,
            error: `Provider ${providerId} credentials are managed by environment variables. Remove the environment variable to log out.`,
          };
        }

        if (provider.logout) {
          await provider.logout();
        }
        await removeCredentialsOrKeychainError(credentialManager, providerId);
        if (!provider.logout && provider.setCredentials) {
          provider.setCredentials({ type: 'api_key', apiKey: '' });
        }
        try {
          await clearCacheAndNotifyProvidersChanged(internalEventBus, providerId, providerRepo);
        } catch {}
        return { success: true };
      } catch (error) {
        try {
          await removeCredentialsOrKeychainError(credentialManager, providerId);
        } catch (cleanupError) {
          if (!(cleanupError instanceof KeychainUnavailableError)) {
            log.error(`Cleanup after logout failure failed for ${providerId}:`, cleanupError);
          }
        }
        const refused =
          error instanceof Error &&
          (error as Error & { logoutRefused?: boolean }).logoutRefused === true;
        if (!refused) {
          try {
            await clearCacheAndNotifyProvidersChanged(internalEventBus, providerId, providerRepo);
          } catch {}
        }
        log.error(`Logout failed for ${providerId}:`, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Logout failed',
        };
      }
    }
  );

  messageHub.onRequest(
    'auth.refresh',
    async (req: ProviderRefreshRequest): Promise<ProviderRefreshResponse> => {
      const { providerId } = req;
      const registry = getProviderRegistry();

      const provider = registry.get(providerId);
      if (!provider) {
        return {
          success: false,
          error: `Provider not found: ${providerId}`,
        };
      }

      if (!provider.refreshToken) {
        return {
          success: false,
          error: `Provider ${providerId} does not support token refresh`,
        };
      }

      try {
        bumpProviderCatalogEpoch(providerId);
        const refreshed = await provider.refreshToken();
        if (!refreshed) {
          let previousCredentials: ProviderCredentials | null = null;
          try {
            previousCredentials = (await credentialManager?.getCredentials?.(providerId)) ?? null;
          } catch {}
          await removeCredentialsOrKeychainError(credentialManager, providerId);
          const remaining = await provider.getCredentials?.();
          if (remaining?.type === 'oauth') {
            await credentialManager?.storeOAuthTokens(providerId, remaining);
          }
          const identityChanged =
            !remaining || credentialIdentity(previousCredentials) !== credentialIdentity(remaining);
          try {
            await clearCacheAndNotifyProvidersChanged(
              internalEventBus,
              providerId,
              providerRepo,
              identityChanged
            );
          } catch {}
          return {
            success: false,
            error: 'Token refresh failed. Please try logging out and logging in again.',
          };
        }
        const credentials = await provider.getCredentials?.();
        if (credentials?.type === 'oauth') {
          await credentialManager?.storeOAuthTokens(providerId, credentials);
        }
        await clearCacheAndNotifyProvidersChanged(
          internalEventBus,
          providerId,
          providerRepo,
          false
        );
        return { success: true };
      } catch (error) {
        log.error(`Token refresh failed for ${providerId}:`, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Token refresh failed',
        };
      }
    }
  );
}
