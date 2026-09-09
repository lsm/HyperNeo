import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  MessageHub,
  type ToolsConfig,
  type GlobalToolsConfig,
  DEFAULT_GLOBAL_TOOLS_CONFIG,
} from '@hyperneo/shared';
import { registerMcpHandlers } from '../../../../src/lib/rpc-handlers/mcp-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { Session } from '@hyperneo/shared';

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

function createMockAgentSession(overrides: Partial<AgentSession> = {}): {
  agentSession: AgentSession;
  mocks: {
    getSessionData: ReturnType<typeof mock>;
    updateToolsConfig: ReturnType<typeof mock>;
  };
} {
  const sessionData: Session = {
    id: 'session-123',
    workspacePath: '/workspace/test',
    status: 'active',
    config: {
      model: 'claude-sonnet-4-20250514',
      tools: {},
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Session;

  const mocks = {
    getSessionData: mock(() => sessionData),
    updateToolsConfig: mock(async () => ({ success: true })),
  };

  const agentSession = {
    ...mocks,
    ...overrides,
  } as unknown as AgentSession;

  return { agentSession, mocks };
}

function createMockSessionManager(): {
  sessionManager: SessionManager;
  mocks: {
    getSession: ReturnType<typeof mock>;
    getGlobalToolsConfig: ReturnType<typeof mock>;
  };
  agentSessionData: ReturnType<typeof createMockAgentSession>;
} {
  const agentSessionData = createMockAgentSession();

  const mocks = {
    getSession: mock(() => agentSessionData.agentSession),
    getGlobalToolsConfig: mock(() => DEFAULT_GLOBAL_TOOLS_CONFIG),
  };

  const sessionManager = {
    ...mocks,
  } as unknown as SessionManager;

  return { sessionManager, mocks, agentSessionData };
}

describe('MCP/Tools RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let sessionManagerData: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    sessionManagerData = createMockSessionManager();

    registerMcpHandlers(messageHubData.hub, sessionManagerData.sessionManager);
  });

  describe('tools.save', () => {
    it('saves tools configuration successfully', async () => {
      const handler = messageHubData.handlers.get('tools.save');
      expect(handler).toBeDefined();

      const params = {
        sessionId: 'session-123',
        tools: {
          useClaudeCodePreset: false,
        } as ToolsConfig,
      };

      const result = await handler!(params, {});

      expect(sessionManagerData.agentSessionData.mocks.updateToolsConfig).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('tools.save');
      expect(handler).toBeDefined();

      sessionManagerData.mocks.getSession.mockReturnValueOnce(null);

      const params = {
        sessionId: 'non-existent',
        tools: {} as ToolsConfig,
      };

      await expect(handler!(params, {})).rejects.toThrow('Session not found: non-existent');
    });

    it('handles tools config with useClaudeCodePreset toggle', async () => {
      const handler = messageHubData.handlers.get('tools.save');
      expect(handler).toBeDefined();

      const params = {
        sessionId: 'session-123',
        tools: {
          useClaudeCodePreset: true,
        } as ToolsConfig,
      };

      const result = await handler!(params, {});

      expect(result).toEqual({ success: true });
    });

    it('handles updateToolsConfig error', async () => {
      const handler = messageHubData.handlers.get('tools.save');
      expect(handler).toBeDefined();

      sessionManagerData.agentSessionData.mocks.updateToolsConfig.mockResolvedValueOnce({
        success: false,
        error: 'Failed to update tools',
      });

      const params = {
        sessionId: 'session-123',
        tools: {} as ToolsConfig,
      };

      const result = await handler!(params, {});

      expect(result).toEqual({ success: false, error: 'Failed to update tools' });
    });
  });

  describe('globalTools.getConfig', () => {
    it('returns global tools configuration', async () => {
      const handler = messageHubData.handlers.get('globalTools.getConfig');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as { config: GlobalToolsConfig };

      expect(sessionManagerData.mocks.getGlobalToolsConfig).toHaveBeenCalled();
      expect(result.config).toBeDefined();
      expect(result.config.systemPrompt).toBeDefined();
      expect(result.config.settingSources).toBeDefined();
      expect(result.config.mcp).toBeDefined();
    });
  });
});
