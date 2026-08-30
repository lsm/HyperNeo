import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupQuestionHandlers } from '../../../../src/lib/rpc-handlers/question-handlers';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';

type RequestHandler = (data: unknown, context?: unknown) => Promise<unknown>;

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

function createMockAgentSession(overrides?: Partial<AgentSession>): AgentSession {
  return {
    handleQuestionResponse: mock(async () => {}),
    updateQuestionDraft: mock(async () => {}),
    handleQuestionCancel: mock(async () => {}),
    ...overrides,
  } as unknown as AgentSession;
}

function createMockSessionManager(session: AgentSession | null = null): SessionManager {
  return {
    getSessionAsync: mock(async () => session),
    getSessionForControl: mock(async () => session),
  } as unknown as SessionManager;
}

function createMockDaemonHub(): DaemonHub {
  return {} as unknown as DaemonHub;
}

describe('question handlers — session routing', () => {
  let mockHub: ReturnType<typeof createMockMessageHub>;
  let daemonHub: DaemonHub;

  beforeEach(() => {
    mockHub = createMockMessageHub();
    daemonHub = createMockDaemonHub();
  });

  describe('question.respond', () => {
    it('routes to runtime session when found in runtime pool', async () => {
      const runtimeSession = createMockAgentSession();
      const sessionManagerSession = createMockAgentSession();
      const sessionManager = createMockSessionManager(sessionManagerSession);

      setupQuestionHandlers(mockHub.hub, sessionManager, daemonHub, (id) =>
        id === 'runtime-session-1' ? runtimeSession : undefined
      );

      const handler = mockHub.handlers.get('question.respond')!;
      await handler({ sessionId: 'runtime-session-1', toolUseId: 'tool-1', responses: [] });

      expect(runtimeSession.handleQuestionResponse).toHaveBeenCalledWith('tool-1', []);
      expect(sessionManagerSession.handleQuestionResponse).not.toHaveBeenCalled();
      expect(sessionManager.getSessionAsync).not.toHaveBeenCalled();
    });

    it('falls back to SessionManager when session not in runtime pool', async () => {
      const sessionManagerSession = createMockAgentSession();
      const sessionManager = createMockSessionManager(sessionManagerSession);

      setupQuestionHandlers(mockHub.hub, sessionManager, daemonHub, (_id) => undefined);

      const handler = mockHub.handlers.get('question.respond')!;
      await handler({ sessionId: 'lobby-session-1', toolUseId: 'tool-2', responses: [] });

      expect(sessionManager.getSessionAsync).toHaveBeenCalledWith('lobby-session-1');
      expect(sessionManagerSession.handleQuestionResponse).toHaveBeenCalledWith('tool-2', []);
    });

    it('works without getRuntimeSession callback (no runtime pool)', async () => {
      const sessionManagerSession = createMockAgentSession();
      const sessionManager = createMockSessionManager(sessionManagerSession);

      setupQuestionHandlers(mockHub.hub, sessionManager, daemonHub);

      const handler = mockHub.handlers.get('question.respond')!;
      await handler({ sessionId: 'lobby-session-1', toolUseId: 'tool-3', responses: [] });

      expect(sessionManager.getSessionAsync).toHaveBeenCalledWith('lobby-session-1');
      expect(sessionManagerSession.handleQuestionResponse).toHaveBeenCalledWith('tool-3', []);
    });

    it('throws when session not found in either pool', async () => {
      const sessionManager = createMockSessionManager(null);

      setupQuestionHandlers(mockHub.hub, sessionManager, daemonHub, (_id) => undefined);

      const handler = mockHub.handlers.get('question.respond')!;
      await expect(
        handler({ sessionId: 'missing-session', toolUseId: 'tool-4', responses: [] })
      ).rejects.toThrow('Session not found: missing-session');
    });
  });

  describe('question.saveDraft', () => {
    it('routes to runtime session when found in runtime pool', async () => {
      const runtimeSession = createMockAgentSession();
      const sessionManager = createMockSessionManager(null);

      setupQuestionHandlers(mockHub.hub, sessionManager, daemonHub, (id) =>
        id === 'runtime-session-2' ? runtimeSession : undefined
      );

      const handler = mockHub.handlers.get('question.saveDraft')!;
      const draftResponses = [{ questionId: 'q1', value: 'draft' }];
      await handler({ sessionId: 'runtime-session-2', draftResponses });

      expect(runtimeSession.updateQuestionDraft).toHaveBeenCalledWith(draftResponses);
      expect(sessionManager.getSessionAsync).not.toHaveBeenCalled();
    });

    it('falls back to the control lookup when session not in runtime pool', async () => {
      const sessionManagerSession = createMockAgentSession();
      const sessionManager = createMockSessionManager(sessionManagerSession);

      setupQuestionHandlers(mockHub.hub, sessionManager, daemonHub, (_id) => undefined);

      const handler = mockHub.handlers.get('question.saveDraft')!;
      const draftResponses = [{ questionId: 'q2', value: 'draft-value' }];
      await handler({ sessionId: 'lobby-session-2', draftResponses });

      expect(sessionManager.getSessionForControl).toHaveBeenCalledWith('lobby-session-2');
      expect(sessionManager.getSessionAsync).not.toHaveBeenCalled();
      expect(sessionManagerSession.updateQuestionDraft).toHaveBeenCalledWith(draftResponses);
    });
  });

  describe('question.cancel', () => {
    it('routes to runtime session when found in runtime pool', async () => {
      const runtimeSession = createMockAgentSession();
      const sessionManager = createMockSessionManager(null);

      setupQuestionHandlers(mockHub.hub, sessionManager, daemonHub, (id) =>
        id === 'runtime-session-3' ? runtimeSession : undefined
      );

      const handler = mockHub.handlers.get('question.cancel')!;
      await handler({ sessionId: 'runtime-session-3', toolUseId: 'tool-cancel-1' });

      expect(runtimeSession.handleQuestionCancel).toHaveBeenCalledWith('tool-cancel-1');
      expect(sessionManager.getSessionAsync).not.toHaveBeenCalled();
    });

    it('falls back to SessionManager when session not in runtime pool', async () => {
      const sessionManagerSession = createMockAgentSession();
      const sessionManager = createMockSessionManager(sessionManagerSession);

      setupQuestionHandlers(mockHub.hub, sessionManager, daemonHub, (_id) => undefined);

      const handler = mockHub.handlers.get('question.cancel')!;
      await handler({ sessionId: 'lobby-session-3', toolUseId: 'tool-cancel-2' });

      expect(sessionManager.getSessionAsync).toHaveBeenCalledWith('lobby-session-3');
      expect(sessionManagerSession.handleQuestionCancel).toHaveBeenCalledWith('tool-cancel-2');
    });
  });
});
