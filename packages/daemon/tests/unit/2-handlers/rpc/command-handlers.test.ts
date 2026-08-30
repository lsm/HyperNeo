import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupCommandHandlers } from '../../../../src/lib/rpc-handlers/command-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';

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

function createMockAgentSession(): {
  agentSession: AgentSession;
  mocks: {
    getSlashCommands: ReturnType<typeof mock>;
  };
} {
  const mocks = {
    getSlashCommands: mock(async () => [
      { name: '/help', description: 'Show available commands' },
      { name: '/clear', description: 'Clear the conversation' },
      { name: '/model', description: 'Switch the model' },
      { name: '/export', description: 'Export conversation' },
    ]),
  };

  const agentSession = {
    ...mocks,
  } as unknown as AgentSession;

  return { agentSession, mocks };
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

describe('Command RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let sessionManagerData: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    sessionManagerData = createMockSessionManager();

    setupCommandHandlers(messageHubData.hub, sessionManagerData.sessionManager);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('commands.list', () => {
    it('returns list of slash commands', async () => {
      const handler = messageHubData.handlers.get('commands.list');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'session-123' }, {})) as {
        commands: Array<{ name: string; description: string }>;
      };

      expect(result.commands).toBeDefined();
      expect(Array.isArray(result.commands)).toBe(true);
      expect(result.commands).toHaveLength(4);
    });

    it('returns commands with correct structure', async () => {
      const handler = messageHubData.handlers.get('commands.list');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'session-123' }, {})) as {
        commands: Array<{ name: string; description: string }>;
      };

      expect(result.commands[0]).toHaveProperty('name');
      expect(result.commands[0]).toHaveProperty('description');
      expect(result.commands[0].name).toBe('/help');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('commands.list');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });

    it('calls getSlashCommands on agent session', async () => {
      const handler = messageHubData.handlers.get('commands.list');
      expect(handler).toBeDefined();

      const { mocks } = createMockAgentSession();
      const customSessionManagerData = createMockSessionManager();

      const { agentSession } = createMockAgentSession();
      customSessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      const newHubData = createMockMessageHub();
      setupCommandHandlers(newHubData.hub, customSessionManagerData.sessionManager);

      const newHandler = newHubData.handlers.get('commands.list');
      await newHandler!({ sessionId: 'session-123' }, {});

      expect(
        (agentSession as unknown as { getSlashCommands: ReturnType<typeof mock> }).getSlashCommands
      ).toHaveBeenCalled();
    });

    it('handles empty command list', async () => {
      const handler = messageHubData.handlers.get('commands.list');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      mocks.getSlashCommands.mockResolvedValueOnce([]);

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      const result = (await handler!({ sessionId: 'session-123' }, {})) as {
        commands: unknown[];
      };

      expect(result.commands).toEqual([]);
    });

    it('handles commands with different structures', async () => {
      const handler = messageHubData.handlers.get('commands.list');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      mocks.getSlashCommands.mockResolvedValueOnce([
        { name: '/custom1', description: 'Custom command 1' },
        { name: '/custom2', description: 'Custom command 2', category: 'utility' },
      ]);

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      const result = (await handler!({ sessionId: 'session-123' }, {})) as {
        commands: Array<{ name: string; description: string }>;
      };

      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].name).toBe('/custom1');
      expect(result.commands[1].name).toBe('/custom2');
    });
  });

  describe('handler registration', () => {
    it('registers commands.list handler', () => {
      expect(messageHubData.handlers.has('commands.list')).toBe(true);
    });
  });
});
