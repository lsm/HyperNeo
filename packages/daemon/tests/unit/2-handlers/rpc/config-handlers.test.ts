import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import { setupConfigHandlers } from '../../../../src/lib/rpc-handlers/config-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';

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

function createMockDaemonHub(): DaemonHub {
  return {
    emit: mock(async () => {}),
    on: mock(() => () => {}),
    off: mock(() => {}),
    once: mock(async () => {}),
  } as unknown as DaemonHub;
}

const defaultSessionConfig: Session['config'] = {
  model: 'claude-sonnet-4-20250514',
  fallbackModel: undefined,
  maxTurns: undefined,
  maxBudgetUsd: undefined,
  maxThinkingTokens: undefined,
  thinkingLevel: 'off',
  systemPrompt: undefined,
  sdkToolsPreset: undefined,
  allowedTools: undefined,
  disallowedTools: undefined,
  agents: undefined,
  sandbox: { enabled: true },
  mcpServers: {},
  strictMcpConfig: undefined,
  outputFormat: undefined,
  betas: [],
  cwd: undefined,
  additionalDirectories: undefined,
  env: undefined,
  executable: undefined,
  executableArgs: undefined,
  permissionMode: 'default',
  allowDangerouslySkipPermissions: false,
  coordinatorMode: false,
};

function createMockAgentSession(configOverrides: Partial<Session['config']> = {}): {
  agentSession: AgentSession;
  mocks: {
    getSessionData: ReturnType<typeof mock>;
    handleModelSwitch: ReturnType<typeof mock>;
    setMaxThinkingTokens: ReturnType<typeof mock>;
    setPermissionMode: ReturnType<typeof mock>;
    updateConfig: ReturnType<typeof mock>;
    updateUserMcpServers: ReturnType<typeof mock>;
    isQueryActiveOrStarting: ReturnType<typeof mock>;
    resetQuery: ReturnType<typeof mock>;
    getMcpServerStatus: ReturnType<typeof mock>;
  };
} {
  const config = { ...defaultSessionConfig, ...configOverrides };

  const mocks = {
    getSessionData: mock(() => ({ id: 'session-123', config })),
    handleModelSwitch: mock(async () => ({ success: true, model: 'claude-opus-4-6' })),
    setMaxThinkingTokens: mock(async () => ({ success: true })),
    setPermissionMode: mock(async () => ({ success: true })),
    updateConfig: mock(async () => {}),
    updateUserMcpServers: mock(async () => {}),
    isQueryActiveOrStarting: mock(() => true),
    resetQuery: mock(async () => ({ success: true })),
    getMcpServerStatus: mock(async () => ({})),
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

describe('SDK Config RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let daemonHub: DaemonHub;
  let sessionManagerData: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    daemonHub = createMockDaemonHub();
    sessionManagerData = createMockSessionManager();

    setupConfigHandlers(messageHubData.hub, sessionManagerData.sessionManager, daemonHub);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('config.model.get', () => {
    it('returns model settings', async () => {
      const handler = messageHubData.handlers.get('config.model.get');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('model');
      expect(result).toHaveProperty('fallbackModel');
      expect(result).toHaveProperty('maxTurns');
      expect(result).toHaveProperty('maxBudgetUsd');
      expect(result).toHaveProperty('maxThinkingTokens');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.model.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.model.update', () => {
    it('updates model successfully', async () => {
      const handler = messageHubData.handlers.get('config.model.update');
      expect(handler).toBeDefined();

      const { mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(
        createMockAgentSession().agentSession
      );

      const result = await handler!(
        { sessionId: 'session-123', settings: { model: 'claude-opus-4-6' } },
        {}
      );

      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('pending');
      expect(result).toHaveProperty('errors');
    });

    it('updates maxThinkingTokens successfully', async () => {
      const handler = messageHubData.handlers.get('config.model.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        { sessionId: 'session-123', settings: { maxThinkingTokens: 8000 } },
        {}
      );

      expect(result).toHaveProperty('applied');
    });

    it('handles model switch failure', async () => {
      const handler = messageHubData.handlers.get('config.model.update');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      mocks.handleModelSwitch.mockResolvedValueOnce({
        success: false,
        error: 'Model not available',
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      const result = (await handler!(
        { sessionId: 'session-123', settings: { model: 'invalid-model' } },
        {}
      )) as { errors: Array<{ field: string; error: string }> };

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('model');
    });

    it('persists fallbackModel without runtime change', async () => {
      const handler = messageHubData.handlers.get('config.model.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        { sessionId: 'session-123', settings: { fallbackModel: 'claude-haiku' } },
        {}
      );

      expect((result as { pending: string[] }).pending).toContain('fallbackModel');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.model.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(
        handler!({ sessionId: 'non-existent', settings: { model: 'claude' } }, {})
      ).rejects.toThrow('Session not found');
    });
  });

  describe('config.systemPrompt.get', () => {
    it('returns system prompt', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.get');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession({
        systemPrompt: 'You are a helpful assistant.',
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('systemPrompt', 'You are a helpful assistant.');
    });

    it('returns undefined when no system prompt', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.get');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('systemPrompt');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.systemPrompt.update', () => {
    it('updates system prompt without restart', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        { sessionId: 'session-123', systemPrompt: 'New system prompt' },
        {}
      );

      expect(result).toEqual({
        success: true,
        applied: false,
        message: 'Restart query to apply changes',
      });
    });

    it('updates system prompt with restart', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          systemPrompt: 'New system prompt',
          restartQuery: true,
        },
        {}
      );

      expect(result).toEqual({ success: true, applied: true });
    });

    it('starts a dormant session through the barrier instead of a no-op restart', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.update');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      mocks.isQueryActiveOrStarting.mockReturnValue(false);
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);
      sessionManagerData.getSessionAsyncMock.mockClear();

      const result = await handler!(
        {
          sessionId: 'session-123',
          systemPrompt: 'New prompt',
          restartQuery: true,
        },
        {}
      );

      expect(result).toEqual({ success: true, applied: true });
      expect(mocks.resetQuery).toHaveBeenCalledWith({ restartQuery: true });
      expect(sessionManagerData.getSessionAsyncMock).toHaveBeenCalledWith('session-123', {
        startQuery: false,
      });
    });

    it('reports restart failure when workflow provisioning is skipped for a dormant worker', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.update');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      mocks.isQueryActiveOrStarting.mockReturnValueOnce(false);
      const workerData = { id: 'space:s1:task:t1:exec:e1', config: {}, status: 'active' };
      const workerSession = {
        ...mocks,
        getSessionData: () => workerData,
      } as unknown as AgentSession;
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(workerSession);

      const result = (await handler!(
        {
          sessionId: 'space:s1:task:t1:exec:e1',
          systemPrompt: 'New prompt',
          restartQuery: true,
        },
        {}
      )) as { success: boolean; applied: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.applied).toBe(false);
      expect(result.error).toContain('not resumable');
    });

    it('reapplies the updated config when the cache-current session was replaced', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.update');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      mocks.isQueryActiveOrStarting.mockReturnValueOnce(false);
      const reapply = mock(async () => {});
      const replacement = {
        ...createMockAgentSession().mocks,
        isQueryActiveOrStarting: () => true,
        getSessionData: () => ({ id: 'session-123', config: {} }),
        updateConfig: reapply,
      } as unknown as AgentSession;
      (
        sessionManagerData.sessionManager as unknown as Record<string, unknown>
      ).getSessionForControl = mock(async () => agentSession);
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(replacement);
      sessionManagerData.getSessionAsyncMock.mockClear();

      await handler!(
        { sessionId: 'session-123', systemPrompt: 'New prompt', restartQuery: true },
        {}
      );

      expect(reapply).toHaveBeenCalledTimes(1);
      expect(reapply).toHaveBeenCalledWith({ systemPrompt: 'New prompt' });
    });

    it('handles restart failure', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.update');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      mocks.resetQuery.mockResolvedValueOnce({ success: false, error: 'Restart failed' });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      const result = await handler!(
        {
          sessionId: 'session-123',
          systemPrompt: 'New prompt',
          restartQuery: true,
        },
        {}
      );

      expect(result).toEqual({
        success: false,
        applied: false,
        error: 'Restart failed',
        message: 'Config saved but restart failed',
      });
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.systemPrompt.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(
        handler!({ sessionId: 'non-existent', systemPrompt: 'test' }, {})
      ).rejects.toThrow('Session not found');
    });
  });

  describe('config.tools.get', () => {
    it('returns tools configuration', async () => {
      const handler = messageHubData.handlers.get('config.tools.get');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession({
        sdkToolsPreset: 'default',
        allowedTools: ['Read', 'Write'],
        disallowedTools: ['Bash'],
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('tools');
      expect(result).toHaveProperty('allowedTools');
      expect(result).toHaveProperty('disallowedTools');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.tools.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.tools.update', () => {
    it('updates tools configuration', async () => {
      const handler = messageHubData.handlers.get('config.tools.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          settings: {
            tools: ['Read', 'Write'],
            allowedTools: ['Read'],
          },
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.tools.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent', settings: {} }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.agents.get', () => {
    it('returns agents configuration', async () => {
      const handler = messageHubData.handlers.get('config.agents.get');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('agents');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.agents.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.agents.update', () => {
    it('updates agents configuration', async () => {
      const handler = messageHubData.handlers.get('config.agents.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          agents: {
            test: { description: 'Test Agent description', prompt: 'Test instructions' },
          },
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.agents.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent', agents: {} }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.sandbox.get', () => {
    it('returns sandbox configuration', async () => {
      const handler = messageHubData.handlers.get('config.sandbox.get');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('sandbox');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.sandbox.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.sandbox.update', () => {
    it('updates sandbox configuration', async () => {
      const handler = messageHubData.handlers.get('config.sandbox.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          sandbox: { enabled: false },
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.sandbox.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(
        handler!({ sessionId: 'non-existent', sandbox: { enabled: true } }, {})
      ).rejects.toThrow('Session not found');
    });
  });

  describe('config.mcp.get', () => {
    it('returns MCP configuration', async () => {
      const handler = messageHubData.handlers.get('config.mcp.get');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('mcpServers');
      expect(result).toHaveProperty('strictMcpConfig');
      expect(result).toHaveProperty('runtimeStatus');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.mcp.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.mcp.update', () => {
    it('updates MCP servers configuration', async () => {
      const handler = messageHubData.handlers.get('config.mcp.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          mcpServers: {
            filesystem: { command: 'npx', args: ['-y', 'mcp-server-filesystem'] },
          },
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('updates strictMcpConfig', async () => {
      const handler = messageHubData.handlers.get('config.mcp.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          strictMcpConfig: true,
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.mcp.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent', mcpServers: {} }, {})).rejects.toThrow(
        'Session not found'
      );
    });

    it('routes mcpServers updates through updateUserMcpServers (preserves in-process servers)', async () => {
      const handler = messageHubData.handlers.get('config.mcp.update');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession({
        mcpServers: {
          'node-agent': { type: 'sdk', name: 'node-agent', instance: {} } as never,
          'space-agent-tools': { type: 'sdk', name: 'space-agent-tools', instance: {} } as never,
          'existing-subprocess': { type: 'stdio', command: 'npx' } as never,
        },
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      await handler!(
        {
          sessionId: 'session-123',
          mcpServers: {
            filesystem: { command: 'npx', args: ['-y', 'mcp-server-filesystem'] },
          },
        },
        {}
      );

      expect(mocks.updateUserMcpServers).toHaveBeenCalledTimes(1);
      expect(mocks.updateConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({ mcpServers: expect.anything() })
      );
    });

    it('does not call updateUserMcpServers when only strictMcpConfig is provided', async () => {
      const handler = messageHubData.handlers.get('config.mcp.update');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      await handler!({ sessionId: 'session-123', strictMcpConfig: true }, {});

      expect(mocks.updateUserMcpServers).not.toHaveBeenCalled();
      expect(mocks.updateConfig).toHaveBeenCalledWith({ strictMcpConfig: true });
    });
  });

  describe('config.mcp.addServer', () => {
    it('adds MCP server', async () => {
      const handler = messageHubData.handlers.get('config.mcp.addServer');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          name: 'new-server',
          config: { command: 'npx', args: ['-y', 'mcp-server'] },
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.mcp.addServer');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(
        handler!({ sessionId: 'non-existent', name: 'server', config: {} }, {})
      ).rejects.toThrow('Session not found');
    });

    it('routes addServer through updateUserMcpServers and preserves in-process servers', async () => {
      const handler = messageHubData.handlers.get('config.mcp.addServer');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession({
        mcpServers: {
          'node-agent': { type: 'sdk', name: 'node-agent', instance: {} } as never,
          'space-agent-tools': { type: 'sdk', name: 'space-agent-tools', instance: {} } as never,
          existing: { type: 'stdio', command: 'echo' } as never,
        },
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      await handler!(
        {
          sessionId: 'session-123',
          name: 'new-subprocess',
          config: { command: 'npx', args: ['-y', 'fake-mcp'] },
        },
        {}
      );

      expect(mocks.updateUserMcpServers).toHaveBeenCalledTimes(1);
      const passed = mocks.updateUserMcpServers.mock.calls[0][0] as Record<
        string,
        { type?: string }
      >;
      expect(passed).toHaveProperty('new-subprocess');
      expect(passed).toHaveProperty('existing');
      expect(passed).not.toHaveProperty('node-agent');
      expect(passed).not.toHaveProperty('space-agent-tools');
    });
  });

  describe('config.mcp.removeServer', () => {
    it('removes MCP server', async () => {
      const handler = messageHubData.handlers.get('config.mcp.removeServer');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession({
        mcpServers: {
          'existing-server': { command: 'npx' },
        },
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      const result = await handler!(
        {
          sessionId: 'session-123',
          name: 'existing-server',
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.mcp.removeServer');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent', name: 'server' }, {})).rejects.toThrow(
        'Session not found'
      );
    });

    it('rejects attempts to remove an in-process (sdk-type) runtime server', async () => {
      const handler = messageHubData.handlers.get('config.mcp.removeServer');
      expect(handler).toBeDefined();

      const { agentSession } = createMockAgentSession({
        mcpServers: {
          'node-agent': { type: 'sdk', name: 'node-agent', instance: {} } as never,
        },
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      await expect(handler!({ sessionId: 'session-123', name: 'node-agent' }, {})).rejects.toThrow(
        /runtime-managed in-process server/i
      );
    });

    it('routes removeServer through updateUserMcpServers and preserves in-process servers', async () => {
      const handler = messageHubData.handlers.get('config.mcp.removeServer');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession({
        mcpServers: {
          'node-agent': { type: 'sdk', name: 'node-agent', instance: {} } as never,
          'space-agent-tools': { type: 'sdk', name: 'space-agent-tools', instance: {} } as never,
          'to-remove': { type: 'stdio', command: 'echo' } as never,
          'to-keep': { type: 'stdio', command: 'echo' } as never,
        },
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue(agentSession);

      await handler!({ sessionId: 'session-123', name: 'to-remove' }, {});

      expect(mocks.updateUserMcpServers).toHaveBeenCalledTimes(1);
      const passed = mocks.updateUserMcpServers.mock.calls[0][0] as Record<string, unknown>;
      expect(passed).toHaveProperty('to-keep');
      expect(passed).not.toHaveProperty('to-remove');
      expect(passed).not.toHaveProperty('node-agent');
      expect(passed).not.toHaveProperty('space-agent-tools');
    });
  });

  describe('config.outputFormat.get', () => {
    it('returns output format', async () => {
      const handler = messageHubData.handlers.get('config.outputFormat.get');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('outputFormat');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.outputFormat.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.outputFormat.update', () => {
    it('updates output format', async () => {
      const handler = messageHubData.handlers.get('config.outputFormat.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          outputFormat: {
            type: 'json_schema',
            schema: { type: 'object', properties: { result: { type: 'string' } } },
          },
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.outputFormat.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(
        handler!({ sessionId: 'non-existent', outputFormat: 'text' }, {})
      ).rejects.toThrow('Session not found');
    });
  });

  describe('config.betas.get', () => {
    it('returns betas configuration', async () => {
      const handler = messageHubData.handlers.get('config.betas.get');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('betas');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.betas.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.betas.update', () => {
    it('updates betas configuration', async () => {
      const handler = messageHubData.handlers.get('config.betas.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          betas: ['context-1m-2025-08-07'],
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.betas.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent', betas: [] }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.env.get', () => {
    it('returns environment settings', async () => {
      const handler = messageHubData.handlers.get('config.env.get');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('cwd');
      expect(result).toHaveProperty('additionalDirectories');
      expect(result).toHaveProperty('env');
      expect(result).toHaveProperty('executable');
      expect(result).toHaveProperty('executableArgs');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.env.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.env.update', () => {
    it('updates environment settings', async () => {
      const handler = messageHubData.handlers.get('config.env.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          settings: {
            cwd: '/workspace/new',
            env: { NODE_ENV: 'test' },
          },
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.env.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent', settings: {} }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.permissions.get', () => {
    it('returns permissions configuration', async () => {
      const handler = messageHubData.handlers.get('config.permissions.get');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('permissionMode');
      expect(result).toHaveProperty('allowDangerouslySkipPermissions');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.permissions.get');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.permissions.update', () => {
    it('updates permissions mode', async () => {
      const handler = messageHubData.handlers.get('config.permissions.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          permissionMode: 'acceptEdits',
        },
        {}
      );

      expect(result).toHaveProperty('success', true);
    });

    it('validates permission mode', async () => {
      const handler = messageHubData.handlers.get('config.permissions.update');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          permissionMode: 'invalid-mode',
        },
        {}
      );

      expect(result).toHaveProperty('success', false);
      expect((result as { error: string }).error).toContain('Invalid permission mode');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.permissions.update');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(
        handler!({ sessionId: 'non-existent', permissionMode: 'default' }, {})
      ).rejects.toThrow('Session not found');
    });
  });

  describe('config.getAll', () => {
    it('returns all configuration', async () => {
      const handler = messageHubData.handlers.get('config.getAll');
      expect(handler).toBeDefined();

      const result = await handler!({ sessionId: 'session-123' }, {});

      expect(result).toHaveProperty('config');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.getAll');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('config.updateBulk', () => {
    it('updates multiple config fields', async () => {
      const handler = messageHubData.handlers.get('config.updateBulk');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          config: {
            systemPrompt: 'New prompt',
            maxTurns: 10,
          },
        },
        {}
      );

      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('pending');
      expect(result).toHaveProperty('errors');
    });

    it('applies runtime-native changes first', async () => {
      const handler = messageHubData.handlers.get('config.updateBulk');
      expect(handler).toBeDefined();

      const result = await handler!(
        {
          sessionId: 'session-123',
          config: {
            model: 'claude-opus-4-6',
            maxThinkingTokens: 16000,
            permissionMode: 'acceptEdits',
            systemPrompt: 'New prompt',
          },
        },
        {}
      );

      expect(result).toHaveProperty('applied');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('config.updateBulk');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent', config: {} }, {})).rejects.toThrow(
        'Session not found'
      );
    });
  });
});
