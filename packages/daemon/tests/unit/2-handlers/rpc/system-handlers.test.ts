import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupSystemHandlers } from '../../../../src/lib/rpc-handlers/system-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import type { Config } from '../../../../src/config';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

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

function createMockSessionManager(): SessionManager {
  return {
    getActiveSessions: mock(() => 3),
    getTotalSessions: mock(() => 10),
  } as unknown as SessionManager;
}

function createMockAuthManager(): {
  authManager: AuthManager;
  getAuthStatusMock: ReturnType<typeof mock>;
} {
  const getAuthStatusMock = mock(async () => ({
    isAuthenticated: true,
    method: 'oauth',
    hasApiKey: false,
  }));

  return {
    authManager: {
      getAuthStatus: getAuthStatusMock,
    } as unknown as AuthManager,
    getAuthStatusMock,
  };
}

function createMockConfig(): Config {
  return {
    defaultModel: 'claude-sonnet-4-20250514',
    maxSessions: 10,
    dbPath: '/path/to/database.db',
  } as unknown as Config;
}

describe('System RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let sessionManager: SessionManager;
  let authManagerData: ReturnType<typeof createMockAuthManager>;
  let config: Config;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    sessionManager = createMockSessionManager();
    authManagerData = createMockAuthManager();
    config = createMockConfig();

    setupSystemHandlers(messageHubData.hub, sessionManager, authManagerData.authManager, config);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('system.health', () => {
    it('returns health status', async () => {
      const handler = messageHubData.handlers.get('system.health');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        status: string;
        version: string;
        uptime: number;
        sessions: { active: number; total: number };
      };

      expect(result.status).toBe('ok');
      expect(result.version).toBeDefined();
      expect(typeof result.uptime).toBe('number');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.sessions.active).toBe(3);
      expect(result.sessions.total).toBe(10);
    });

    it('returns correct session counts', async () => {
      const handler = messageHubData.handlers.get('system.health');
      expect(handler).toBeDefined();

      const customSessionManager = {
        getActiveSessions: mock(() => 5),
        getTotalSessions: mock(() => 25),
      } as unknown as SessionManager;

      const newHubData = createMockMessageHub();
      setupSystemHandlers(
        newHubData.hub,
        customSessionManager,
        authManagerData.authManager,
        config
      );

      const newHandler = newHubData.handlers.get('system.health');
      const result = (await newHandler!({}, {})) as {
        sessions: { active: number; total: number };
      };

      expect(result.sessions.active).toBe(5);
      expect(result.sessions.total).toBe(25);
    });
  });

  describe('system.config', () => {
    it('returns daemon configuration', async () => {
      const handler = messageHubData.handlers.get('system.config');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as {
        version: string;
        claudeSDKVersion: string;
        defaultModel: string;
        maxSessions: number;
        storageLocation: string;
        authMethod: string;
        authStatus: { isAuthenticated: boolean; method: string };
      };

      expect(result.version).toBeDefined();
      expect(result.claudeSDKVersion).toBeDefined();
      expect(result.defaultModel).toBe('claude-sonnet-4-20250514');
      expect(result.maxSessions).toBe(10);
      expect(result.storageLocation).toBe('/path/to/database.db');
      expect(result.authMethod).toBe('oauth');
      expect(result.authStatus.isAuthenticated).toBe(true);
    });

    it('includes auth status from auth manager', async () => {
      const handler = messageHubData.handlers.get('system.config');
      expect(handler).toBeDefined();

      authManagerData.getAuthStatusMock.mockResolvedValueOnce({
        isAuthenticated: true,
        method: 'api_key',
        hasApiKey: true,
      });

      const result = (await handler!({}, {})) as {
        authMethod: string;
        authStatus: { isAuthenticated: boolean; method: string; hasApiKey: boolean };
      };

      expect(result.authMethod).toBe('api_key');
      expect(result.authStatus.hasApiKey).toBe(true);
    });

    it('handles unauthenticated status', async () => {
      const handler = messageHubData.handlers.get('system.config');
      expect(handler).toBeDefined();

      authManagerData.getAuthStatusMock.mockResolvedValueOnce({
        isAuthenticated: false,
        method: 'none',
        hasApiKey: false,
      });

      const result = (await handler!({}, {})) as {
        authMethod: string;
        authStatus: { isAuthenticated: boolean };
      };

      expect(result.authMethod).toBe('none');
      expect(result.authStatus.isAuthenticated).toBe(false);
    });
  });

  describe('test.echo', () => {
    it('echoes the message back', async () => {
      const handler = messageHubData.handlers.get('test.echo');
      expect(handler).toBeDefined();

      const result = (await handler!({ message: 'Hello, World!' }, {})) as {
        echoed: string;
      };

      expect(result.echoed).toBe('Hello, World!');
    });

    it('defaults to "echo" when no message provided', async () => {
      const handler = messageHubData.handlers.get('test.echo');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as { echoed: string };

      expect(result.echoed).toBe('echo');
    });

    it('publishes event to test.echo channel', async () => {
      const handler = messageHubData.handlers.get('test.echo');
      expect(handler).toBeDefined();

      await handler!({ message: 'test message' }, {});

      expect(messageHubData.hub.event).toHaveBeenCalledWith(
        'test.echo',
        { echo: 'test message' },
        { channel: 'global' }
      );
    });

    it('handles empty string message', async () => {
      const handler = messageHubData.handlers.get('test.echo');
      expect(handler).toBeDefined();

      const result = (await handler!({ message: '' }, {})) as { echoed: string };

      expect(result.echoed).toBe('echo');
    });

    it('handles special characters in message', async () => {
      const handler = messageHubData.handlers.get('test.echo');
      expect(handler).toBeDefined();

      const specialMessage = 'Hello! @#$%^&*() {}[]|\\:";\'<>?,./~`';

      const result = (await handler!({ message: specialMessage }, {})) as {
        echoed: string;
      };

      expect(result.echoed).toBe(specialMessage);
    });

    it('handles unicode characters in message', async () => {
      const handler = messageHubData.handlers.get('test.echo');
      expect(handler).toBeDefined();

      const unicodeMessage = 'Hello \u4e16\u754c \ud83c\udf0d';

      const result = (await handler!({ message: unicodeMessage }, {})) as {
        echoed: string;
      };

      expect(result.echoed).toBe(unicodeMessage);
    });
  });
});
