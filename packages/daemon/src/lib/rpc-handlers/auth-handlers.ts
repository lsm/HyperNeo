/**
 * Auth RPC Handlers
 *
 * Handles authentication-related RPC calls including:
 * - NeoKai auth status (Anthropic API key / OAuth)
 * - Provider auth status (OpenAI, GitHub Copilot, etc.)
 * - Provider OAuth login/logout
 */

import type { MessageHub } from '@neokai/shared';
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
} from '@neokai/shared/provider';
import type { AuthManager } from '../auth-manager';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager';
import {
  KEYCHAIN_UNAVAILABLE_MESSAGE,
  KeychainUnavailableError,
} from '../credentials/credential-store.js';
import { getProviderRegistry } from '../providers/registry';
import { registerBuiltInProvider } from '../providers/factory.js';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { Logger } from '../logger';
const log = new Logger('auth-handlers');

async function clearCacheAndNotifyProvidersChanged(
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>
): Promise<void> {
  const { clearModelsCache } = await import('../model-service.js');
  clearModelsCache();
  internalEventBus?.publishAsync('providers.changed', { sessionId: 'global' });
}

/**
 * Remove stored credentials, converting macOS Keychain-unavailable failures
 * into a clear user-facing error. With macOS Keychain-only persistence there is
 * no local DB fallback to delete, so logout/delete must not claim success while
 * the keychain item may still exist.
 */
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

/**
 * Setup authentication-related RPC handlers
 */
export function setupAuthHandlers(
  messageHub: MessageHub,
  authManager: AuthManager,
  credentialManager?: ProviderCredentialManager,
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>
): void {
  // NeoKai auth status (Anthropic)
  messageHub.onRequest('auth.status', async () => {
    const authStatus = await authManager.getAuthStatus();
    return { authStatus };
  });

  // List all providers with their auth status
  messageHub.onRequest('auth.providers', async (): Promise<ListProviderAuthStatusResponse> => {
    const registry = getProviderRegistry();
    const providers = registry.getAll();

    const providerStatuses: ProviderAuthStatus[] = await Promise.all(
      providers.map(async (provider) => {
        // Get auth status if provider supports it
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
            };
          } else {
            // Fallback: use isAvailable()
            const available = await provider.isAvailable();
            authStatus = {
              id: provider.id,
              displayName: provider.displayName,
              isAuthenticated: available,
            };
          }
        } catch (error) {
          log.error(`Failed to get auth status for ${provider.id}:`, error);
          authStatus = {
            id: provider.id,
            displayName: provider.displayName,
            isAuthenticated: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }

        return authStatus;
      })
    );

    return { providers: providerStatuses };
  });

  // Initiate OAuth login for a provider
  messageHub.onRequest(
    'auth.login',
    async (req: ProviderAuthRequest): Promise<ProviderAuthResponse> => {
      const { providerId } = req;
      // Re-register built-in providers that may have been unregistered (e.g.,
      // after the user deleted and is now re-adding the provider).
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
          await clearCacheAndNotifyProvidersChanged(internalEventBus);
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

  // Logout from a provider
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
        const hasEnvironmentCredentials =
          credentialManager?.hasEnvironmentCredentials(providerId) ?? false;
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
          // Unreadable stored row — clear it, then run provider logout if available
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
          // If the macOS Keychain is locked/unavailable, getCredentials() returns
          // null even when a real credential exists there. Attempt the remove
          // so the caller surfaces the unlock guidance instead of silently
          // claiming the credential is env-managed and leaving it in Keychain.
          //
          // Both `keychain-unavailable` and `keychain-fallback` mean the
          // Keychain is unreachable: the former blocks all writes, the
          // latter has at least one fallback-routed entry. Either way, the
          // Keychain copy of this provider (if any) is still locked behind
          // the GUI wall and we want the removeCredentials attempt to
          // surface unlock guidance rather than report env-managed.
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
        // Keychain-only persistence: if removal fails because the keychain is
        // locked, do not claim logout succeeded. The credential may still exist
        // and could authenticate again after unlock.
        await removeCredentialsOrKeychainError(credentialManager, providerId);
        if (!provider.logout && provider.setCredentials) {
          provider.setCredentials({ type: 'api_key', apiKey: '' });
        }
        await clearCacheAndNotifyProvidersChanged(internalEventBus);
        return { success: true };
      } catch (error) {
        try {
          await removeCredentialsOrKeychainError(credentialManager, providerId);
        } catch (cleanupError) {
          if (!(cleanupError instanceof KeychainUnavailableError)) {
            log.error(`Cleanup after logout failure failed for ${providerId}:`, cleanupError);
          }
        }
        await clearCacheAndNotifyProvidersChanged(internalEventBus);
        log.error(`Logout failed for ${providerId}:`, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Logout failed',
        };
      }
    }
  );

  // Refresh token for a provider
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
          // Remove the credential store row first. For providers like Codex,
          // getCredentials() can re-import stale credentials from an external
          // auth file after a definitive failure, making a post-logout probe
          // falsely truthy and leaving a stale row in place. Best-effort: if
          // the keychain is locked, the rethrow won't skip the restore below.
          await removeCredentialsOrKeychainError(credentialManager, providerId);
          const remaining = await provider.getCredentials?.();
          if (remaining?.type === 'oauth') {
            // Transient failure — provider still holds credentials. Restore row.
            await credentialManager?.storeOAuthTokens(providerId, remaining);
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
        await clearCacheAndNotifyProvidersChanged(internalEventBus);
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
