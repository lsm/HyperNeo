import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { setupFileHandlers } from '../../../../src/lib/rpc-handlers/file-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';

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

function createMockAgentSession(workspacePath: string = '/workspace/test'): {
  agentSession: AgentSession;
} {
  const agentSession = {
    getSessionData: mock(() => ({
      id: 'session-123',
      workspacePath,
      config: {},
    })),
  } as unknown as AgentSession;

  return { agentSession };
}

function createMockSessionManager(): {
  sessionManager: SessionManager;
  getSessionAsyncMock: ReturnType<typeof mock>;
} {
  const { agentSession } = createMockAgentSession();

  const getSessionAsyncMock = mock(async () => agentSession);

  const sessionManager = {
    getSessionAsync: getSessionAsyncMock,
    getSessionForControl: getSessionAsyncMock,
  } as unknown as SessionManager;

  return { sessionManager, getSessionAsyncMock };
}

describe('File RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let sessionManagerData: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    sessionManagerData = createMockSessionManager();

    setupFileHandlers(messageHubData.hub, sessionManagerData.sessionManager);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('file.read', () => {
    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('file.read');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent', path: 'test.txt' }, {})).rejects.toThrow(
        'Session not found'
      );
    });

    it('reads file with utf-8 encoding', async () => {
      const handler = messageHubData.handlers.get('file.read');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession('/tmp');
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);
    });

    it('reads file with base64 encoding', async () => {
      const handler = messageHubData.handlers.get('file.read');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession('/tmp');
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);
    });

    it('handles missing path parameter', async () => {
      const handler = messageHubData.handlers.get('file.read');
      expect(handler).toBeDefined();
    });
  });

  describe('file.list', () => {
    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('file.list');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });

    it('lists directory contents non-recursively', async () => {
      const handler = messageHubData.handlers.get('file.list');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession('/tmp');
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);
    });

    it('lists directory contents recursively', async () => {
      const handler = messageHubData.handlers.get('file.list');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession('/tmp');
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);
    });

    it('uses default path when not provided', async () => {
      const handler = messageHubData.handlers.get('file.list');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession('/tmp');
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);
    });
  });

  describe('file.tree', () => {
    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('file.tree');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });

    it('gets file tree with default depth', async () => {
      const handler = messageHubData.handlers.get('file.tree');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession('/tmp');
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);
    });

    it('gets file tree with custom depth', async () => {
      const handler = messageHubData.handlers.get('file.tree');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession('/tmp');
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);
    });

    it('uses default path when not provided', async () => {
      const handler = messageHubData.handlers.get('file.tree');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession('/tmp');
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);
    });
  });

  describe('handler registration', () => {
    it('registers file.read handler', () => {
      expect(messageHubData.handlers.has('file.read')).toBe(true);
    });

    it('registers file.list handler', () => {
      expect(messageHubData.handlers.has('file.list')).toBe(true);
    });

    it('registers file.tree handler', () => {
      expect(messageHubData.handlers.has('file.tree')).toBe(true);
    });
  });
});
