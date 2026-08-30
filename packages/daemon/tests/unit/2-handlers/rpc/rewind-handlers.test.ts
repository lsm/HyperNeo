import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupRewindHandlers } from '../../../../src/lib/rpc-handlers/rewind-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
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

function createMockAgentSession(): {
  agentSession: AgentSession;
  mocks: {
    getRewindPoints: ReturnType<typeof mock>;
    previewRewind: ReturnType<typeof mock>;
    executeRewind: ReturnType<typeof mock>;
    previewSelectiveRewind: ReturnType<typeof mock>;
    executeSelectiveRewind: ReturnType<typeof mock>;
  };
} {
  const mocks = {
    getRewindPoints: mock(() => [
      {
        id: 'checkpoint-1',
        timestamp: Date.now() - 1000,
        messageCount: 5,
        description: 'Initial checkpoint',
      },
      {
        id: 'checkpoint-2',
        timestamp: Date.now() - 500,
        messageCount: 10,
        description: 'Second checkpoint',
      },
    ]),
    previewRewind: mock(async () => ({
      canRewind: true,
      filesToRevert: ['src/file1.ts', 'src/file2.ts'],
      messagesToDelete: 5,
    })),
    executeRewind: mock(async () => ({
      success: true,
      filesReverted: ['src/file1.ts', 'src/file2.ts'],
      messagesDeleted: 5,
    })),
    previewSelectiveRewind: mock(async () => ({
      canRewind: true,
      messagesToDelete: 3,
      filesToRevert: ['src/modified.ts'],
    })),
    executeSelectiveRewind: mock(async () => ({
      success: true,
      messagesDeleted: 3,
      filesReverted: ['src/modified.ts'],
    })),
  };

  const agentSession = {
    ...mocks,
    getSessionData: mock(() => ({ id: 'rewind-session', config: {} })),
    replayPendingMessagesForImmediateMode: mock(async () => {}),
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

describe('Rewind RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let daemonHub: DaemonHub;
  let sessionManagerData: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    daemonHub = createMockDaemonHub();
    sessionManagerData = createMockSessionManager();

    setupRewindHandlers(messageHubData.hub, sessionManagerData.sessionManager, daemonHub);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('rewind.checkpoints', () => {
    it('returns rewind points for a session', async () => {
      const handler = messageHubData.handlers.get('rewind.checkpoints');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'session-123' }, {})) as {
        rewindPoints: Array<{ id: string }>;
      };

      expect(result.rewindPoints).toBeDefined();
      expect(result.rewindPoints).toHaveLength(2);
      expect(result.rewindPoints[0].id).toBe('checkpoint-1');
    });

    it('returns empty array when session not found', async () => {
      const handler = messageHubData.handlers.get('rewind.checkpoints');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      const result = (await handler!({ sessionId: 'non-existent' }, {})) as {
        rewindPoints: Array<unknown>;
        error?: string;
      };

      expect(result.rewindPoints).toEqual([]);
      expect(result.error).toBe('Session not found');
    });
  });

  describe('rewind.preview', () => {
    it('returns preview for a valid checkpoint', async () => {
      const handler = messageHubData.handlers.get('rewind.preview');
      expect(handler).toBeDefined();

      const result = (await handler!(
        { sessionId: 'session-123', checkpointId: 'checkpoint-1' },
        {}
      )) as { preview: { canRewind: boolean; filesToRevert: string[] } };

      expect(result.preview).toBeDefined();
      expect(result.preview.canRewind).toBe(true);
      expect(result.preview.filesToRevert).toContain('src/file1.ts');
    });

    it('returns error preview when session not found', async () => {
      const handler = messageHubData.handlers.get('rewind.preview');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      const result = (await handler!(
        { sessionId: 'non-existent', checkpointId: 'checkpoint-1' },
        {}
      )) as { preview: { canRewind: boolean; error: string } };

      expect(result.preview.canRewind).toBe(false);
      expect(result.preview.error).toBe('Session not found');
    });
  });

  it('rejects an empty selective preview without provisioning', async () => {
    const handler = messageHubData.handlers.get('rewind.previewSelective');
    expect(handler).toBeDefined();

    sessionManagerData.getSessionAsyncMock.mockClear();

    const result = (await handler!({ sessionId: 'session-123', messageIds: [] }, {})) as {
      preview: { canRewind: boolean; error: string };
    };

    expect(result.preview.error).toBe('No messages selected');
    expect(sessionManagerData.getSessionAsyncMock).not.toHaveBeenCalled();
  });

  it('previews provision dormant workers without replaying pending messages', async () => {
    const handler = messageHubData.handlers.get('rewind.preview');
    expect(handler).toBeDefined();

    await handler!({ sessionId: 'session-123', checkpointId: 'checkpoint-1' }, {});

    expect(sessionManagerData.getSessionAsyncMock).toHaveBeenCalledWith('session-123', {
      replayPendingMessages: false,
    });
  });

  describe('rewind.execute', () => {
    it('executes rewind with default files mode', async () => {
      const handler = messageHubData.handlers.get('rewind.execute');
      expect(handler).toBeDefined();

      const { mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValue({
        ...mocks,
        getSessionData: () => ({ id: 'session-123', config: {} }),
        replayPendingMessagesForImmediateMode: async () => {},
      } as unknown as AgentSession);

      const result = (await handler!(
        { sessionId: 'session-123', checkpointId: 'checkpoint-1' },
        {}
      )) as { result: { success: boolean; filesReverted: string[] } };

      expect(result.result).toBeDefined();
      expect(result.result.success).toBe(true);
    });

    it('executes rewind with conversation mode', async () => {
      const handler = messageHubData.handlers.get('rewind.execute');
      expect(handler).toBeDefined();

      const { mocks } = createMockAgentSession();
      mocks.executeRewind.mockResolvedValueOnce({
        success: true,
        filesReverted: [],
        messagesDeleted: 10,
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue({
        ...mocks,
        getSessionData: () => ({ id: 'session-123', config: {} }),
        replayPendingMessagesForImmediateMode: async () => {},
      } as unknown as AgentSession);

      const result = (await handler!(
        { sessionId: 'session-123', checkpointId: 'checkpoint-1', mode: 'conversation' },
        {}
      )) as { result: { success: boolean; messagesDeleted: number } };

      expect(result.result.success).toBe(true);
    });

    it('executes rewind with both mode', async () => {
      const handler = messageHubData.handlers.get('rewind.execute');
      expect(handler).toBeDefined();

      const { mocks } = createMockAgentSession();
      mocks.executeRewind.mockResolvedValueOnce({
        success: true,
        filesReverted: ['src/file1.ts'],
        messagesDeleted: 10,
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue({
        ...mocks,
        getSessionData: () => ({ id: 'session-123', config: {} }),
        replayPendingMessagesForImmediateMode: async () => {},
      } as unknown as AgentSession);

      const result = (await handler!(
        { sessionId: 'session-123', checkpointId: 'checkpoint-1', mode: 'both' },
        {}
      )) as { result: { success: boolean } };

      expect(result.result.success).toBe(true);
    });

    it('returns error result when session not found', async () => {
      const handler = messageHubData.handlers.get('rewind.execute');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      const result = (await handler!(
        { sessionId: 'non-existent', checkpointId: 'checkpoint-1' },
        {}
      )) as { result: { success: boolean; error: string } };

      expect(result.result.success).toBe(false);
      expect(result.result.error).toBe('Session not found');
    });
  });

  describe('rewind.previewSelective', () => {
    it('returns preview for selective rewind', async () => {
      const handler = messageHubData.handlers.get('rewind.previewSelective');
      expect(handler).toBeDefined();

      const result = (await handler!(
        { sessionId: 'session-123', messageIds: ['msg-1', 'msg-2'] },
        {}
      )) as { preview: { canRewind: boolean; messagesToDelete: number } };

      expect(result.preview).toBeDefined();
      expect(result.preview.canRewind).toBe(true);
      expect(result.preview.messagesToDelete).toBe(3);
    });

    it('returns error preview when session not found', async () => {
      const handler = messageHubData.handlers.get('rewind.previewSelective');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      const result = (await handler!({ sessionId: 'non-existent', messageIds: ['msg-1'] }, {})) as {
        preview: { canRewind: boolean; error: string };
      };

      expect(result.preview.canRewind).toBe(false);
      expect(result.preview.error).toBe('Session not found');
    });

    it('returns error preview when no messages selected', async () => {
      const handler = messageHubData.handlers.get('rewind.previewSelective');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'session-123', messageIds: [] }, {})) as {
        preview: { canRewind: boolean; error: string };
      };

      expect(result.preview.canRewind).toBe(false);
      expect(result.preview.error).toBe('No messages selected');
    });
  });

  describe('rewind.executeSelective', () => {
    it('executes selective rewind with default both mode', async () => {
      const handler = messageHubData.handlers.get('rewind.executeSelective');
      expect(handler).toBeDefined();

      const { mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValue({
        ...mocks,
        getSessionData: () => ({ id: 'session-123', config: {} }),
        replayPendingMessagesForImmediateMode: async () => {},
      } as unknown as AgentSession);

      const result = (await handler!(
        { sessionId: 'session-123', messageIds: ['msg-1', 'msg-2'] },
        {}
      )) as { result: { success: boolean; messagesDeleted: number } };

      expect(result.result).toBeDefined();
      expect(result.result.success).toBe(true);
      expect(result.result.messagesDeleted).toBe(3);
    });

    it('executes selective rewind with files mode', async () => {
      const handler = messageHubData.handlers.get('rewind.executeSelective');
      expect(handler).toBeDefined();

      const { mocks } = createMockAgentSession();
      mocks.executeSelectiveRewind.mockResolvedValueOnce({
        success: true,
        messagesDeleted: 0,
        filesReverted: ['src/file.ts'],
      });
      sessionManagerData.getSessionAsyncMock.mockResolvedValue({
        ...mocks,
        getSessionData: () => ({ id: 'session-123', config: {} }),
        replayPendingMessagesForImmediateMode: async () => {},
      } as unknown as AgentSession);

      const result = (await handler!(
        { sessionId: 'session-123', messageIds: ['msg-1'], mode: 'files' },
        {}
      )) as { result: { success: boolean } };

      expect(result.result.success).toBe(true);
    });

    it('returns error result when session not found', async () => {
      const handler = messageHubData.handlers.get('rewind.executeSelective');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      const result = (await handler!({ sessionId: 'non-existent', messageIds: ['msg-1'] }, {})) as {
        result: { success: boolean; error: string };
      };

      expect(result.result.success).toBe(false);
      expect(result.result.error).toBe('Session not found');
    });

    it('returns error result when no messages selected', async () => {
      const handler = messageHubData.handlers.get('rewind.executeSelective');
      expect(handler).toBeDefined();

      const result = (await handler!({ sessionId: 'session-123', messageIds: [] }, {})) as {
        result: { success: boolean; error: string };
      };

      expect(result.result.success).toBe(false);
      expect(result.result.error).toBe('No messages selected');
    });
  });
});
