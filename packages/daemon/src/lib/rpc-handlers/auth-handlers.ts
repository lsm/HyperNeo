import type { MessageHub } from '@hyperneo/shared';
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
import { providerEnvCoordinator } from '../providers/provider-env-enrollment.ts';
import { registerBuiltInProvider } from '../providers/factory.js';
import type { ProviderRepository } from '../../storage/repositories/provider-repository.ts';
import { stripPersistedDiscovery } from './provider-handlers.ts';
import {
  applyRecordedFailureToAuthStatus,
  classifyProviderFailure,
} from '../providers/provider-failure-store.js';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
const log = new Logger('auth-handlers');

async function clearCacheAndNotifyProvidersChanged(
  providerId: string | undefined,
  providerRepo: ProviderRepository | undefined,
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>,
  stripPersisted = true
): Promise<void> {
  if (providerId && providerRepo && stripPersisted) {
    const record = providerRepo.getProviderByProviderId(providerId);
    if (record) {
      const stripped = stripPersistedDiscovery(record.configJson);
      if (stripped !== record.configJson) {
        providerRepo.updateProvider(record.id, { configJson: stripped });
      }
    }
  }
  const { clearModelsCache } = await import('../model-service.js');
  clearModelsCache();
  internalEventBus?.publishAsync('providers.changed', { sessionId: 'global' });
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
          if (credentials.type === 'oauth') {
            await credentialManager?.storeOAuthTokens(providerId, credentials);
          }
          unsubscribe?.();
          await clearCacheAndNotifyProvidersChanged(providerId, providerRepo, internalEventBus);
        };
        unsubscribe = provider.onCredentialsChanged?.(persistCredentials);
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
        await clearCacheAndNotifyProvidersChanged(providerId, providerRepo, internalEventBus);
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
          await clearCacheAndNotifyProvidersChanged(providerId, providerRepo, internalEventBus);
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
        const refreshed = await provider.refreshToken();
        if (!refreshed) {
          await removeCredentialsOrKeychainError(credentialManager, providerId);
          const remaining = await provider.getCredentials?.();
          if (remaining?.type === 'oauth') {
            await credentialManager?.storeOAuthTokens(providerId, remaining);
            await clearCacheAndNotifyProvidersChanged(
              providerId,
              providerRepo,
              internalEventBus,
              false
            );
          } else {
            await clearCacheAndNotifyProvidersChanged(providerId, providerRepo, internalEventBus);
          }
          return {
            success: false,
            error: 'Token refresh failed. Please try logging out and logging in again.',
          };
        }
        const credentials = await provider.getCredentials?.();
        if (credentials?.type === 'oauth') {
          await credentialManager?.storeOAuthTokens(providerId, credentials);
        }
        await clearCacheAndNotifyProvidersChanged(providerId, providerRepo, internalEventBus);
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
