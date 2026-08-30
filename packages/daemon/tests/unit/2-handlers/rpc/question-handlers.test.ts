import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type QuestionDraftResponse } from '@hyperneo/shared';
import { setupQuestionHandlers } from '../../../../src/lib/rpc-handlers/question-handlers';
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
    handleQuestionResponse: ReturnType<typeof mock>;
    updateQuestionDraft: ReturnType<typeof mock>;
    handleQuestionCancel: ReturnType<typeof mock>;
  };
} {
  const mocks = {
    handleQuestionResponse: mock(async () => {}),
    updateQuestionDraft: mock(async () => {}),
    handleQuestionCancel: mock(async () => {}),
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

describe('Question RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let daemonHub: DaemonHub;
  let sessionManagerData: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    daemonHub = createMockDaemonHub();
    sessionManagerData = createMockSessionManager();

    setupQuestionHandlers(messageHubData.hub, sessionManagerData.sessionManager, daemonHub);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('question.respond', () => {
    it('sends response to pending question', async () => {
      const handler = messageHubData.handlers.get('question.respond');
      expect(handler).toBeDefined();

      const responses: QuestionDraftResponse[] = [
        { questionId: 'q-1', selectedOptions: ['option-a'] },
      ];

      const result = (await handler!(
        {
          sessionId: 'session-123',
          toolUseId: 'tool-123',
          responses,
        },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
    });

    it('calls handleQuestionResponse on agent session', async () => {
      const handler = messageHubData.handlers.get('question.respond');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      const responses: QuestionDraftResponse[] = [
        { questionId: 'q-1', selectedOptions: ['option-a', 'option-b'], textResponse: 'Some text' },
      ];

      await handler!(
        {
          sessionId: 'session-123',
          toolUseId: 'tool-use-456',
          responses,
        },
        {}
      );

      expect(mocks.handleQuestionResponse).toHaveBeenCalledWith('tool-use-456', responses);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('question.respond');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(
        handler!({ sessionId: 'non-existent', toolUseId: 'tool-123', responses: [] }, {})
      ).rejects.toThrow('Session not found: non-existent');
    });

    it('handles multiple responses', async () => {
      const handler = messageHubData.handlers.get('question.respond');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      const responses: QuestionDraftResponse[] = [
        { questionId: 'q-1', selectedOptions: ['option-a'] },
        { questionId: 'q-2', selectedOptions: ['option-x'], textResponse: 'Additional info' },
      ];

      await handler!(
        {
          sessionId: 'session-123',
          toolUseId: 'tool-123',
          responses,
        },
        {}
      );

      expect(mocks.handleQuestionResponse).toHaveBeenCalledWith('tool-123', responses);
    });

    it('handles empty responses array', async () => {
      const handler = messageHubData.handlers.get('question.respond');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      await handler!(
        {
          sessionId: 'session-123',
          toolUseId: 'tool-123',
          responses: [],
        },
        {}
      );

      expect(mocks.handleQuestionResponse).toHaveBeenCalledWith('tool-123', []);
    });

    it('handles responses with text only', async () => {
      const handler = messageHubData.handlers.get('question.respond');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      const responses: QuestionDraftResponse[] = [
        { questionId: 'q-1', textResponse: 'Just text response' },
      ];

      await handler!(
        {
          sessionId: 'session-123',
          toolUseId: 'tool-123',
          responses,
        },
        {}
      );

      expect(mocks.handleQuestionResponse).toHaveBeenCalled();
    });
  });

  describe('question.saveDraft', () => {
    it('saves draft responses', async () => {
      const handler = messageHubData.handlers.get('question.saveDraft');
      expect(handler).toBeDefined();

      const draftResponses: QuestionDraftResponse[] = [
        { questionId: 'q-1', selectedOptions: ['option-a'] },
      ];

      const result = (await handler!(
        {
          sessionId: 'session-123',
          draftResponses,
        },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
    });

    it('calls updateQuestionDraft on agent session', async () => {
      const handler = messageHubData.handlers.get('question.saveDraft');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      const draftResponses: QuestionDraftResponse[] = [
        { questionId: 'q-1', selectedOptions: ['option-b'] },
        { questionId: 'q-2', textResponse: 'Draft text' },
      ];

      await handler!(
        {
          sessionId: 'session-123',
          draftResponses,
        },
        {}
      );

      expect(mocks.updateQuestionDraft).toHaveBeenCalledWith(draftResponses);
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('question.saveDraft');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(handler!({ sessionId: 'non-existent', draftResponses: [] }, {})).rejects.toThrow(
        'Session not found: non-existent'
      );
    });

    it('handles empty draft responses', async () => {
      const handler = messageHubData.handlers.get('question.saveDraft');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      await handler!(
        {
          sessionId: 'session-123',
          draftResponses: [],
        },
        {}
      );

      expect(mocks.updateQuestionDraft).toHaveBeenCalledWith([]);
    });

    it('handles partial draft responses', async () => {
      const handler = messageHubData.handlers.get('question.saveDraft');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      const draftResponses: QuestionDraftResponse[] = [{ questionId: 'q-1', selectedOptions: [] }];

      await handler!(
        {
          sessionId: 'session-123',
          draftResponses,
        },
        {}
      );

      expect(mocks.updateQuestionDraft).toHaveBeenCalledWith(draftResponses);
    });
  });

  describe('question.cancel', () => {
    it('cancels pending question', async () => {
      const handler = messageHubData.handlers.get('question.cancel');
      expect(handler).toBeDefined();

      const result = (await handler!(
        {
          sessionId: 'session-123',
          toolUseId: 'tool-123',
        },
        {}
      )) as { success: boolean };

      expect(result.success).toBe(true);
    });

    it('calls handleQuestionCancel on agent session', async () => {
      const handler = messageHubData.handlers.get('question.cancel');
      expect(handler).toBeDefined();

      const { agentSession, mocks } = createMockAgentSession();
      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(agentSession);

      await handler!(
        {
          sessionId: 'session-123',
          toolUseId: 'tool-use-789',
        },
        {}
      );

      expect(mocks.handleQuestionCancel).toHaveBeenCalledWith('tool-use-789');
    });

    it('throws error when session not found', async () => {
      const handler = messageHubData.handlers.get('question.cancel');
      expect(handler).toBeDefined();

      sessionManagerData.getSessionAsyncMock.mockResolvedValueOnce(null);

      await expect(
        handler!({ sessionId: 'non-existent', toolUseId: 'tool-123' }, {})
      ).rejects.toThrow('Session not found: non-existent');
    });
  });

  describe('handler registration', () => {
    it('registers question.respond handler', () => {
      expect(messageHubData.handlers.has('question.respond')).toBe(true);
    });

    it('registers question.saveDraft handler', () => {
      expect(messageHubData.handlers.has('question.saveDraft')).toBe(true);
    });

    it('registers question.cancel handler', () => {
      expect(messageHubData.handlers.has('question.cancel')).toBe(true);
    });
  });
});
