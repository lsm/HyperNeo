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
  ProviderRefreshRequest,
  ProviderRefreshResponse,
  ListProviderAuthStatusResponse,
  ProviderCredentials,
} from '@neokai/shared/provider';
import type { AuthManager } from '../auth-manager';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager';
import { getProviderRegistry } from '../providers/registry';
import { registerBuiltInProvider } from '../providers/factory.js';
import { Logger } from '../logger';
const log = new Logger('auth-handlers');

/**
 * Setup authentication-related RPC handlers
 */
export function setupAuthHandlers(
  messageHub: MessageHub,
  authManager: AuthManager,
  credentialManager?: ProviderCredentialManager
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
      registerBuiltInProvider(registry, providerId);

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
    async (req: ProviderLogoutRequest): Promise<{ success: boolean; error?: string }> => {
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
          await credentialManager?.removeCredentials(providerId);
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
          if (credentialManager) {
            await credentialManager.removeCredentials(providerId);
          }
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
        // on the next daemon startup.
        await credentialManager?.removeCredentials(providerId);
        if (!provider.logout && provider.setCredentials) {
          provider.setCredentials({ type: 'api_key', apiKey: '' });
        }
        return { success: true };
      } catch (error) {
        if (credentialManager) {
          await credentialManager.removeCredentials(providerId);
        }
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
          // Definitive refresh failure — clear the stale credential store row so
          // syncAllProviders() doesn't resurrect it on the next startup.
          await credentialManager?.removeCredentials(providerId);
          return {
            success: false,
            error: 'Token refresh failed. Please try logging out and logging in again.',
          };
        }
        const credentials = await provider.getCredentials?.();
        if (credentials?.type === 'oauth') {
          await credentialManager?.storeOAuthTokens(providerId, credentials);
        }
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
