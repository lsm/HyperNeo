import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupSystemHandlers } from '../../../../src/lib/rpc-handlers/system-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import { BUILD_METADATA } from '../../../../src/lib/build-metadata';
import daemonPackageJson from '../../../../package.json' with { type: 'json' };

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

function createMockSessionManager(active = 3, total = 10): SessionManager {
  return {
    getActiveSessions: mock(() => active),
    getTotalSessions: mock(() => total),
    getDatabase: () => ({ gateway: { call: mock(async () => total) } }),
  } as unknown as SessionManager;
}

describe('System RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let sessionManager: SessionManager;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    sessionManager = createMockSessionManager();

    setupSystemHandlers(messageHubData.hub, sessionManager);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('system.health', () => {
    it('reports the daemon package version', async () => {
      const handler = messageHubData.handlers.get('system.health')!;
      const result = (await handler({}, {})) as { version: string };

      expect(result.version).toBe(daemonPackageJson.version);
      expect(result.version).toBe(BUILD_METADATA.version);
    });

    it('reports uptime in milliseconds since the daemon started', async () => {
      const handler = messageHubData.handlers.get('system.health')!;
      const first = (await handler({}, {})) as { uptime: number };
      await new Promise((resolve) => setTimeout(resolve, 25));
      const second = (await handler({}, {})) as { uptime: number };

      expect(second.uptime - first.uptime).toBeGreaterThanOrEqual(20);
      expect(second.uptime - first.uptime).toBeLessThan(5_000);
    });

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

      const customSessionManager = createMockSessionManager(5, 25);

      const newHubData = createMockMessageHub();
      setupSystemHandlers(newHubData.hub, customSessionManager);

      const newHandler = newHubData.handlers.get('system.health');
      const result = (await newHandler!({}, {})) as {
        sessions: { active: number; total: number };
      };

      expect(result.sessions.active).toBe(5);
      expect(result.sessions.total).toBe(25);
    });
  });
});
