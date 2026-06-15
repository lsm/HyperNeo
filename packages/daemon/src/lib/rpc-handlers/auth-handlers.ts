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
import { KeychainUnavailableError } from '../credentials/credential-store.js';
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
 * Best-effort `removeCredentials`. `FallbackCredentialStore.delete()` rethrows
 * `KeychainUnavailableError` after the fallback row has been removed so callers
 * can surface partial logout (the keychain entry still exists and could
 * re-authenticate the user after `security unlock-keychain`). Wrap the call so
 * auth handlers can return a clear "logged out locally, retry after unlock"
 * message instead of double-throwing through outer catch blocks.
 *
 * Returns `'partial'` when the keychain was unavailable; `'removed'` otherwise.
 */
async function safeRemoveCredentials(
  credentialManager: ProviderCredentialManager | undefined,
  providerId: string
): Promise<'removed' | 'partial'> {
  if (!credentialManager) return 'removed';
  try {
    await credentialManager.removeCredentials(providerId);
    return 'removed';
  } catch (error) {
    if (error instanceof KeychainUnavailableError) {
      log.warn(
        `Partial logout for ${providerId}: macOS Keychain unavailable — credential still in keychain. Run \`security unlock-keychain\` and retry.`
      );
      return 'partial';
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
          await safeRemoveCredentials(credentialManager, providerId);
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
          await safeRemoveCredentials(credentialManager, providerId);
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
          return {
            success: false,
            error: `Provider ${providerId} credentials are managed by environment variables. Remove the environment variable to log out.`,
          };
        }

        if (provider.logout) {
          await provider.logout();
        }
        // Always clear the credential store row so stale rows don't resurrect
        // on the next daemon startup. `safeRemoveCredentials` returns 'partial'
        // when the macOS Keychain was unavailable (locked / no GUI session) —
        // surface that to the user so they can `security unlock-keychain` and
        // retry to fully remove the credential.
        const removalStatus = await safeRemoveCredentials(credentialManager, providerId);
        if (!provider.logout && provider.setCredentials) {
          provider.setCredentials({ type: 'api_key', apiKey: '' });
        }
        await clearCacheAndNotifyProvidersChanged(internalEventBus);
        if (removalStatus === 'partial') {
          return {
            success: true,
            warning:
              'Logged out from local store. macOS Keychain is locked — run ' +
              '`security unlock-keychain` and retry to remove the keychain entry.',
          };
        }
        return { success: true };
      } catch (error) {
        // Best-effort cleanup; don't let a locked keychain mask the original
        // error by re-throwing out of this catch and skipping the cache clear
        // + structured error return below.
        await safeRemoveCredentials(credentialManager, providerId);
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
          await safeRemoveCredentials(credentialManager, providerId);
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
