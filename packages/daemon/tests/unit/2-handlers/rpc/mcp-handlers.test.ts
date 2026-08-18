import { describe, expect, it, beforeEach, mock, afterEach, afterAll } from 'bun:test';
import {
  MessageHub,
  type ToolsConfig,
  type GlobalToolsConfig,
  DEFAULT_GLOBAL_TOOLS_CONFIG,
} from '@hyperneo/shared';
import { registerMcpHandlers } from '../../../../src/lib/rpc-handlers/mcp-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { AppMcpLifecycleManager } from '../../../../src/lib/mcp';
import type { Session } from '@hyperneo/shared';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

mock.module('node:fs/promises', () => ({
  readFile: mock(async () => '{}'),
}));

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
    saveGlobalToolsConfig: ReturnType<typeof mock>;
  };
  agentSessionData: ReturnType<typeof createMockAgentSession>;
} {
  const agentSessionData = createMockAgentSession();

  const mocks = {
    getSession: mock(() => agentSessionData.agentSession),
    getGlobalToolsConfig: mock(() => DEFAULT_GLOBAL_TOOLS_CONFIG),
    saveGlobalToolsConfig: mock(() => {}),
  };

  const sessionManager = {
    ...mocks,
  } as unknown as SessionManager;

  return { sessionManager, mocks, agentSessionData };
}

function createMockAppMcpManager(): {
  manager: AppMcpLifecycleManager;
  mocks: { getStartupErrors: ReturnType<typeof mock> };
} {
  const mocks = {
    getStartupErrors: mock(() => []),
  };
  const manager = mocks as unknown as AppMcpLifecycleManager;
  return { manager, mocks };
}

describe('MCP/Tools RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let sessionManagerData: ReturnType<typeof createMockSessionManager>;
  let appMcpManagerData: ReturnType<typeof createMockAppMcpManager>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    sessionManagerData = createMockSessionManager();
    appMcpManagerData = createMockAppMcpManager();

    registerMcpHandlers(
      messageHubData.hub,
      sessionManagerData.sessionManager,
      appMcpManagerData.manager
    );
  });

  afterEach(() => {
    mock.restore();
    mock.module('node:fs/promises', () => ({
      readFile: mock(async () => '{}'),
    }));
  });

  afterAll(() => {
    mock.module('node:fs/promises', () => require('node:fs/promises'));
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

  describe('mcp.listServers', () => {
    it('returns list of MCP servers from .mcp.json', async () => {
      const handler = messageHubData.handlers.get('mcp.listServers');
      expect(handler).toBeDefined();

      const mockConfig = JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
          },
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
          },
        },
      });

      mock.module('node:fs/promises', () => ({
        readFile: mock(async () => mockConfig),
      }));

      const params = {
        sessionId: 'session-123',
      };

      const result = (await handler!(params, {})) as { servers: Record<string, unknown> };

      expect(result.servers).toBeDefined();
    });

    it('returns empty object when .mcp.json does not exist', async () => {
      const handler = messageHubData.handlers.get('mcp.listServers');
      expect(handler).toBeDefined();

      mock.module('node:fs/promises', () => ({
        readFile: mock(async () => {
          throw new Error('ENOENT: no such file');
        }),
      }));

      const params = {
        sessionId: 'session-123',
      };

      const result = (await handler!(params, {})) as { servers: Record<string, unknown> };

      expect(result.servers).toEqual({});
    });

    it('returns empty object when .mcp.json is invalid JSON', async () => {
      const handler = messageHubData.handlers.get('mcp.listServers');
      expect(handler).toBeDefined();

      mock.module('node:fs/promises', () => ({
        readFile: mock(async () => 'not valid json'),
      }));

      const params = {
        sessionId: 'session-123',
      };

      const result = (await handler!(params, {})) as { servers: Record<string, unknown> };

      expect(result.servers).toEqual({});
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('mcp.listServers');
      expect(handler).toBeDefined();

      sessionManagerData.mocks.getSession.mockReturnValueOnce(null);

      const params = {
        sessionId: 'non-existent',
      };

      await expect(handler!(params, {})).rejects.toThrow('Session not found: non-existent');
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

  describe('globalTools.saveConfig', () => {
    it('saves global tools configuration', async () => {
      const handler = messageHubData.handlers.get('globalTools.saveConfig');
      expect(handler).toBeDefined();

      const params = {
        config: DEFAULT_GLOBAL_TOOLS_CONFIG,
      };

      await handler!(params, {});

      expect(sessionManagerData.mocks.saveGlobalToolsConfig).toHaveBeenCalledWith(params.config);
    });
  });

  describe('mcp.registry.listErrors', () => {
    it('surfaces startup validation errors from the app MCP registry', async () => {
      const handler = messageHubData.handlers.get('mcp.registry.listErrors');
      expect(handler).toBeDefined();

      appMcpManagerData.mocks.getStartupErrors.mockReturnValueOnce([
        { name: 'broken-server', error: 'missing command' },
      ]);

      const result = await handler!({}, {});

      expect(appMcpManagerData.mocks.getStartupErrors).toHaveBeenCalled();
      expect(result).toEqual([{ name: 'broken-server', error: 'missing command' }]);
    });
  });
});
