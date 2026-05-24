/**
 * Tests for Auth RPC Handlers
 *
 * Tests the RPC handlers for authentication operations:
 * - auth.status - Get NeoKai auth status
 * - auth.providers - List all providers with auth status
 * - auth.login - Initiate OAuth login for a provider
 * - auth.logout - Logout from a provider
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupAuthHandlers } from '../../../../src/lib/rpc-handlers/auth-handlers';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import type { Provider } from '../../../../src/lib/providers/types';
import { resetProviderRegistry, getProviderRegistry } from '../../../../src/lib/providers/registry';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock AuthManager
const mockAuthManager = {
  getAuthStatus: mock(async () => ({
    isAuthenticated: true,
    method: 'api_key' as const,
  })),
};

// Mock Provider for testing
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

// Pre-created mock providers for use in tests
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

// Helper to create a minimal mock MessageHub that captures handlers
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

    // Reset provider registry
    resetProviderRegistry();
    registry = getProviderRegistry();

    // Reset mocks
    mockAuthManager.getAuthStatus.mockClear();

    // Setup handlers
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
      // Use getProviderRegistry directly to ensure we get the same instance the handler uses
      const testRegistry = getProviderRegistry();
      const mockProvider = createMockProvider();
      testRegistry.register(mockProvider);

      // Verify provider was registered
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

    it('handles errors from getAuthStatus', async () => {
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
        providers: Array<{ id: string; isAuthenticated: boolean; error?: string }>;
      };

      expect(result.providers[0].isAuthenticated).toBe(false);
      expect(result.providers[0].error).toBe('Auth check failed');
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
      expect(result.error).toContain('does not support logout');
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
