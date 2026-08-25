import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupAuthHandlers } from '../../../../src/lib/rpc-handlers/auth-handlers';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import type { Provider } from '@hyperneo/shared/provider';
import { resetProviderRegistry, getProviderRegistry } from '../../../../src/lib/providers/registry';
import { providerEnvCoordinator } from '../../../../src/lib/providers/provider-env-enrollment';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import {
  recordClassifiedProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';
import { KeychainUnavailableError } from '../../../../src/lib/credentials/credential-store';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

const mockAuthManager = {
  getAuthStatus: mock(async () => ({
    isAuthenticated: true,
    method: 'api_key' as const,
  })),
};

function createMockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'test-provider',
    displayName: 'Test Provider',
    isAvailable: mock(async () => true),
    getAuthStatus: mock(async () => ({
      isAuthenticated: true,
      method: 'oauth' as const,
    })),
    startOAuthFlow: mock(async () => ({
      authUrl: 'https://example.com/oauth',
    })),
    logout: mock(async () => {}),
    ...overrides,
  } as Provider;
}

const mockProvider = createMockProvider();
const mockProviderNoOAuth = createMockProvider({
  id: 'test-provider-no-oauth',
  displayName: 'Test Provider No OAuth',
  startOAuthFlow: undefined,
});
const mockProviderNoLogout = createMockProvider({
  id: 'test-provider-no-logout',
  displayName: 'Test Provider No Logout',
  logout: undefined,
});

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();

  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;

  return { hub, handlers };
}

describe('Auth RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let registry: ReturnType<typeof getProviderRegistry>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();

    resetProviderRegistry();
    resetProviderFailureStore();
    registry = getProviderRegistry();

    mockAuthManager.getAuthStatus.mockClear();

    setupAuthHandlers(messageHubData.hub, mockAuthManager as unknown as AuthManager);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('auth.status', () => {
    it('returns auth status', async () => {
      const handler = messageHubData.handlers.get('auth.status');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as { authStatus: unknown };

      expect(mockAuthManager.getAuthStatus).toHaveBeenCalled();
      expect(result.authStatus).toBeDefined();
    });
  });

  describe('auth.providers', () => {
    it('returns empty providers list when no providers', async () => {
      const handler = messageHubData.handlers.get('auth.providers');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as { providers: unknown[] };

      expect(result.providers).toEqual([]);
    });

    it('returns providers with auth status', async () => {
      const testRegistry = getProviderRegistry();
      const mockProvider = createMockProvider();
      testRegistry.register(mockProvider);

      expect(testRegistry.getAll()).toHaveLength(1);

      const handler = messageHubData.handlers.get('auth.providers');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        providers: Array<{ id: string; isAuthenticated: boolean }>;
      };

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].id).toBe('test-provider');
      expect(result.providers[0].isAuthenticated).toBe(true);
    });

    it('uses isAvailable when getAuthStatus not implemented', async () => {
      const testRegistry = getProviderRegistry();
      const mockProvider = createMockProvider({
        getAuthStatus: undefined,
        isAvailable: mock(async () => false),
      });
      testRegistry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.providers');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        providers: Array<{ id: string; isAuthenticated: boolean }>;
      };

      expect(result.providers[0].isAuthenticated).toBe(false);
    });

    it('classifies thrown getAuthStatus errors with errorKind', async () => {
      const testRegistry = getProviderRegistry();
      const mockProvider = createMockProvider({
        getAuthStatus: mock(async () => {
          throw new Error('Auth check failed');
        }),
      });
      testRegistry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.providers');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        providers: Array<{
          id: string;
          isAuthenticated: boolean;
          error?: string;
          errorKind?: string;
        }>;
      };

      expect(result.providers[0].isAuthenticated).toBe(false);
      expect(result.providers[0].error).toBe('Auth check failed');
      expect(result.providers[0].errorKind).toBe('transient');
    });

    it('classifies credential-pattern thrown getAuthStatus errors as credential', async () => {
      const testRegistry = getProviderRegistry();
      const mockProvider = createMockProvider({
        getAuthStatus: mock(async () => {
          throw new Error('(http 401) invalid key');
        }),
      });
      testRegistry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.providers');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        providers: Array<{
          id: string;
          isAuthenticated: boolean;
          error?: string;
          errorKind?: string;
        }>;
      };

      expect(result.providers[0].isAuthenticated).toBe(false);
      expect(result.providers[0].error).toBe('(http 401) invalid key');
      expect(result.providers[0].errorKind).toBe('credential');
    });

    it('applies recorded failures for providers without a built-in overlay', async () => {
      const testRegistry = getProviderRegistry();
      const mockProvider = createMockProvider({
        getAuthStatus: mock(async () => ({ isAuthenticated: true })),
      });
      testRegistry.register(mockProvider);
      recordClassifiedProviderFailure('test-provider', {
        errorKind: 'credential',
        message: '(http 401) invalid key',
      });

      const handler = messageHubData.handlers.get('auth.providers');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        providers: Array<{ isAuthenticated: boolean; error?: string; errorKind?: string }>;
      };

      expect(result.providers[0]).toMatchObject({
        isAuthenticated: false,
        error: '(http 401) invalid key',
        errorKind: 'credential',
      });
    });

    it('propagates errorKind from provider auth status', async () => {
      const testRegistry = getProviderRegistry();
      const mockProvider = createMockProvider({
        getAuthStatus: mock(async () => ({
          isAuthenticated: false,
          errorKind: 'transient' as const,
        })),
      });
      testRegistry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.providers');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        providers: Array<{ id: string; isAuthenticated: boolean; errorKind?: string }>;
      };

      expect(result.providers[0].errorKind).toBe('transient');
    });

    it('passes errorKind through to the provider status', async () => {
      const testRegistry = getProviderRegistry();
      const mockProvider = createMockProvider({
        getAuthStatus: mock(async () => ({
          isAuthenticated: false,
          method: 'api_key' as const,
          error: 'Z.ai API key rejected (HTTP 401)',
          errorKind: 'credential' as const,
        })),
      });
      testRegistry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.providers');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        providers: Array<{
          id: string;
          isAuthenticated: boolean;
          error?: string;
          errorKind?: 'credential' | 'transient';
        }>;
      };

      expect(result.providers[0].isAuthenticated).toBe(false);
      expect(result.providers[0].error).toBe('Z.ai API key rejected (HTTP 401)');
      expect(result.providers[0].errorKind).toBe('credential');
    });
  });

  describe('auth.login', () => {
    it('returns error when provider not found', async () => {
      const handler = messageHubData.handlers.get('auth.login');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'non-existent' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Provider not found');
    });

    it('re-initializes built-in providers that were unregistered', async () => {
      resetProviderFactory();
      resetProviderRegistry();
      registry = getProviderRegistry();

      const mockProvider = createMockProvider({ id: 'anthropic-codex' });
      registry.register(mockProvider);

      registry.unregister('anthropic-codex');
      expect(registry.has('anthropic-codex')).toBe(false);

      setupAuthHandlers(messageHubData.hub, mockAuthManager as unknown as AuthManager);

      const handler = messageHubData.handlers.get('auth.login');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'anthropic-codex' }, {})) as {
        success: boolean;
        authUrl?: string;
      };

      expect(registry.has('anthropic-codex')).toBe(true);
      expect(result.success).toBe(true);
    });

    it('returns error when provider does not support OAuth', async () => {
      const mockProvider = createMockProvider({
        startOAuthFlow: undefined,
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.login');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support OAuth login');
    });

    it('returns OAuth flow data on success', async () => {
      const mockProvider = createMockProvider();
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.login');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        authUrl?: string;
      };

      expect(result.success).toBe(true);
      expect(result.authUrl).toBe('https://example.com/oauth');
    });

    it('persists provider-owned OAuth credentials when login flow completes asynchronously', async () => {
      const credentialManager = {
        storeOAuthTokens: mock(async () => {}),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const credentials = {
        type: 'oauth' as const,
        accessToken: 'new-token',
        refreshToken: 'refresh-token',
      };
      let listener: ((credentials: typeof credentials) => void | Promise<void>) | undefined;
      const mockProvider = createMockProvider({
        getCredentials: mock(() => ({ type: 'oauth' as const, accessToken: 'stale-token' })),
        onCredentialsChanged: mock((handler) => {
          listener = handler as typeof listener;
          return () => {
            listener = undefined;
          };
        }),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.login');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
      };
      await listener?.(credentials);
      await Promise.resolve();

      expect(result.success).toBe(true);
      expect(credentialManager.storeOAuthTokens).toHaveBeenCalledTimes(1);
      expect(credentialManager.storeOAuthTokens).toHaveBeenCalledWith('test-provider', credentials);
    });

    it('handles OAuth flow errors', async () => {
      const mockProvider = createMockProvider({
        startOAuthFlow: mock(async () => {
          throw new Error('OAuth failed');
        }),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.login');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('OAuth failed');
    });
  });

  describe('auth.logout', () => {
    it('returns error when provider not found', async () => {
      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'non-existent' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Provider not found');
    });

    it('returns error when provider does not support logout', async () => {
      const mockProvider = createMockProvider({
        logout: undefined,
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('managed by environment variables');
    });

    it('returns success on logout', async () => {
      const mockProvider = createMockProvider();
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(mockProvider.logout).toHaveBeenCalled();
    });

    it('removes provider credential store row on logout', async () => {
      const credentialManager = {
        getCredentials: mock(async () => ({ type: 'api_key' as const, apiKey: 'stored-key' })),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => false),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider();
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('always removes credential store row even when stored row is absent', async () => {
      const credentialManager = {
        getCredentials: mock(async () => null),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => false),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider();
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(mockProvider.logout).toHaveBeenCalled();
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('removes provider credential store row when provider has no logout method', async () => {
      const credentialManager = {
        getCredentials: mock(async () => ({ type: 'api_key' as const, apiKey: 'stored-key' })),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => false),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({ logout: undefined });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('reads environment credentials for the logout early return only after a foreign lease window closes', async () => {
      let envHasToken = false;
      const seenWindowStates: boolean[] = [];
      const credentialManager = {
        getCredentials: mock(async () => null),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => {
          seenWindowStates.push(envHasToken);
          return envHasToken;
        }),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({ logout: undefined });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const token = await providerEnvCoordinator.acquire('anthropic.loadModelsFromSdk');
      envHasToken = true;
      const pending = handler!({ providerId: 'test-provider' }, {});
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(seenWindowStates).toEqual([]);

      envHasToken = false;
      providerEnvCoordinator.release(token);
      const result = (await pending) as { success: boolean };

      expect(seenWindowStates).toEqual([false]);
      expect(result.success).toBe(false);
      expect(providerEnvCoordinator.isLeaseHeld()).toBe(false);
    });

    it('returns managed-by-environment error when no provider logout or stored row exists', async () => {
      const credentialManager = {
        getCredentials: mock(async () => null),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => false),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({ logout: undefined });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('managed by environment variables');
      expect(credentialManager.removeCredentials).not.toHaveBeenCalled();
    });

    it('surfaces externally-managed message and completes app-side cleanup on refused external logout', async () => {
      const credentialManager = {
        getCredentials: mock(async () => ({ type: 'oauth' as const, accessToken: 'gho_stored' })),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => false),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({
        logout: mock(async () => {
          throw new Error(
            'GitHub Copilot credentials are managed by the COPILOT_GITHUB_TOKEN environment variable. Remove that source to log out.'
          );
        }),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('COPILOT_GITHUB_TOKEN');
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('surfaces keychain guidance when locked-read returns null and provider has no logout', async () => {
      const credentialManager = {
        getCredentials: mock(async () => null),
        removeCredentials: mock(async () => {
          throw new KeychainUnavailableError('keychain locked');
        }),
        hasEnvironmentCredentials: mock(() => false),
        getCredentialStoreStatus: mock(() => ({
          backend: 'keychain-unavailable',
          keychainAvailable: false,
          warning: 'macOS Keychain is locked or unavailable.',
        })),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({ logout: undefined });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('security unlock-keychain');
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('surfaces keychain guidance when backend is keychain-fallback (round 7 fix)', async () => {
      const credentialManager = {
        getCredentials: mock(async () => null),
        removeCredentials: mock(async () => {
          throw new KeychainUnavailableError('keychain locked');
        }),
        hasEnvironmentCredentials: mock(() => false),
        getCredentialStoreStatus: mock(() => ({
          backend: 'keychain-fallback',
          keychainAvailable: false,
          warning: 'Using local encrypted file storage.',
        })),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({ logout: undefined });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('security unlock-keychain');
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('returns managed-by-environment error and removes stale row when env overrides storage', async () => {
      const credentialManager = {
        getCredentials: mock(async () => ({ type: 'api_key' as const, apiKey: 'stored-key' })),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => true),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({ logout: undefined });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('managed by environment variables');
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
      expect(credentialManager.getCredentials).not.toHaveBeenCalled();
    });

    it('removes unreadable provider credential store row on logout', async () => {
      const credentialManager = {
        getCredentials: mock(async () => {
          throw new Error('decrypt failed');
        }),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => false),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({ logout: undefined });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('decrypt failed');
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('removes unreadable credential store row and runs provider logout', async () => {
      const credentialManager = {
        getCredentials: mock(async () => {
          throw new Error('decrypt failed');
        }),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => false),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider();
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('decrypt failed');
      expect(mockProvider.logout).toHaveBeenCalledTimes(1);
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('returns provider logout failures and clears credential store row once', async () => {
      const credentialManager = {
        getCredentials: mock(async () => ({ type: 'api_key' as const, apiKey: 'stored-key' })),
        removeCredentials: mock(async () => {}),
        hasEnvironmentCredentials: mock(() => false),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({
        logout: mock(async () => {
          throw new Error('revoke failed');
        }),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('revoke failed');
      expect(mockProvider.logout).toHaveBeenCalledTimes(1);
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('handles logout errors', async () => {
      const mockProvider = createMockProvider({
        logout: mock(async () => {
          throw new Error('Logout failed');
        }),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('Logout failed');
    });

    it('returns failure when removeCredentials throws KeychainUnavailableError', async () => {
      const credentialManager = {
        getCredentials: mock(async () => ({ type: 'api_key' as const, apiKey: 'stored-key' })),
        removeCredentials: mock(async () => {
          throw new KeychainUnavailableError('The user name or passphrase is not correct');
        }),
        hasEnvironmentCredentials: mock(() => false),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider();
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('security unlock-keychain');
      expect(mockProvider.logout).toHaveBeenCalledTimes(1);
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('returns keychain guidance when env-managed cleanup hits locked keychain', async () => {
      const credentialManager = {
        removeCredentials: mock(async () => {
          throw new KeychainUnavailableError('keychain locked');
        }),
        hasEnvironmentCredentials: mock(() => true),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({ logout: undefined });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.logout');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('security unlock-keychain');
      expect(credentialManager.removeCredentials).toHaveBeenCalledTimes(2);
    });
  });

  describe('auth.refresh', () => {
    it('returns error when provider not found', async () => {
      const handler = messageHubData.handlers.get('auth.refresh');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'non-existent' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Provider not found');
    });

    it('returns error when provider does not support token refresh', async () => {
      const mockProvider = createMockProvider({
        refreshToken: undefined,
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.refresh');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support token refresh');
    });

    it('returns success when token refresh succeeds', async () => {
      const mockProvider = createMockProvider({
        refreshToken: mock(async () => true),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.refresh');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(mockProvider.refreshToken).toHaveBeenCalled();
    });

    it('persists refreshed OAuth credentials to credential store', async () => {
      const credentialManager = {
        storeOAuthTokens: mock(async () => {}),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const credentials = {
        type: 'oauth' as const,
        accessToken: 'new-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60_000,
      };
      const mockProvider = createMockProvider({
        refreshToken: mock(async () => true),
        getCredentials: mock(() => credentials),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.refresh');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
      expect(credentialManager.storeOAuthTokens).toHaveBeenCalledWith('test-provider', credentials);
    });

    it('returns error when token refresh fails', async () => {
      const mockProvider = createMockProvider({
        refreshToken: mock(async () => false),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.refresh');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Please try logging out');
    });

    it('removes stale credentials from store on definitive refresh failure', async () => {
      const credentialManager = {
        removeCredentials: mock(async () => {}),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({
        refreshToken: mock(async () => false),
        getCredentials: mock(async () => null),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.refresh');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
    });

    it('restores credential store row on transient refresh failure', async () => {
      const credentialManager = {
        removeCredentials: mock(async () => {}),
        storeOAuthTokens: mock(async () => {}),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({
        refreshToken: mock(async () => false),
        getCredentials: mock(async () => ({
          type: 'oauth' as const,
          accessToken: 'still-valid',
        })),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.refresh');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
      expect(credentialManager.storeOAuthTokens).toHaveBeenCalledWith('test-provider', {
        type: 'oauth',
        accessToken: 'still-valid',
      });
    });

    it('returns keychain guidance when refresh cleanup hits locked keychain', async () => {
      const credentialManager = {
        removeCredentials: mock(async () => {
          throw new KeychainUnavailableError('keychain locked');
        }),
        storeOAuthTokens: mock(async () => {}),
      };
      setupAuthHandlers(
        messageHubData.hub,
        mockAuthManager as unknown as AuthManager,
        credentialManager as never
      );
      const mockProvider = createMockProvider({
        refreshToken: mock(async () => false),
        getCredentials: mock(async () => ({
          type: 'oauth' as const,
          accessToken: 'still-valid',
        })),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.refresh');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('security unlock-keychain');
      expect(credentialManager.removeCredentials).toHaveBeenCalledWith('test-provider');
      expect(credentialManager.storeOAuthTokens).not.toHaveBeenCalled();
    });

    it('handles refresh token errors', async () => {
      const mockProvider = createMockProvider({
        refreshToken: mock(async () => {
          throw new Error('Token refresh failed');
        }),
      });
      registry.register(mockProvider);

      const handler = messageHubData.handlers.get('auth.refresh');
      expect(handler).toBeDefined();

      const result = (await handler!({ providerId: 'test-provider' }, {})) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token refresh failed');
    });
  });
});
