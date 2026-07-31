/**
 * Unit tests for AgentSession.clearConversationContext() — the "/clear"
 * equivalent used by `resetContextPerTurn` agent slots to give a node fresh
 * eyes at the start of each handoff.
 *
 * Verifies the core invariants:
 *  - The SDK session pointer (sdkSessionId / sdkOriginPath) is wiped in memory
 *    AND persisted, so the restarted query does not resume prior history.
 *  - The query is stopped and restarted (fresh conversation, no resume).
 *  - NeoKai's own message history is NOT touched — updateSession is called only
 *    with the sdk session fields, never a message-deletion method.
 */
import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { Database } from '../../../../src/storage/database.ts';
import type { MessageHub, Session } from '@hyperneo/shared';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';

function createAgentSession(overrides: Partial<Session> = {}): AgentSession {
  const mockSession: Session = {
    id: `test-session-${Math.random()}`,
    title: 'Test Session',
    workspacePath: '/test/workspace',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
    },
    metadata: {},
    ...overrides,
  } as Session;

  const mockDb = {
    getSession: mock(() => mockSession),
    updateSession: mock(() => {}),
    getUserMessages: mock(() => []),
    getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
    deleteMessagesAfter: mock(() => 0),
    deleteMessagesAtAndAfter: mock(() => 0),
    getUserMessageByUuid: mock(() => undefined),
    countMessagesAfter: mock(() => 0),
    getMessagesByStatus: mock(() => []),
    updateMessage: mock(() => {}),
    getSDKMessageCount: mock(() => 0),
    getConsumedUserMessagesAfterLatestInit: mock(() => []),
  } as unknown as Database;

  return new AgentSession(
    mockSession,
    mockDb,
    {} as MessageHub,
    {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<DaemonInternalEventMap>,
    mock(async () => 'test-api-key')
  );
}

describe('AgentSession.clearConversationContext', () => {
  it('wipes the SDK session pointer in memory and persists it', async () => {
    const session = createAgentSession({
      sdkSessionId: 'sdk-1',
      sdkOriginPath: '/p',
    } as Partial<Session>);
    const db = session.db as unknown as { updateSession: ReturnType<typeof mock> };
    // Prevent the real SDK subprocess spawn / model fetch.
    spyOn(session, 'startStreamingQuery').mockResolvedValue(undefined);
    spyOn(session, 'clearModelsCache').mockResolvedValue(undefined);
    spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
    spyOn(session['stateManager'], 'setIdle').mockResolvedValue(undefined);
    spyOn(session['messageQueue'], 'clear');
    spyOn(session['messageHandler'], 'resetCircuitBreaker');

    await session.clearConversationContext();

    expect(session.session.sdkSessionId).toBeUndefined();
    expect(session.session.sdkOriginPath).toBeUndefined();
    expect(db.updateSession).toHaveBeenCalledWith(session.session.id, {
      sdkSessionId: undefined,
      sdkOriginPath: undefined,
    });
  });

  it('restarts the query exactly once so the next turn runs in a fresh conversation', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    const startSpy = spyOn(session, 'startStreamingQuery').mockResolvedValue(undefined);
    spyOn(session, 'clearModelsCache').mockResolvedValue(undefined);
    spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
    spyOn(session['stateManager'], 'setIdle').mockResolvedValue(undefined);

    await session.clearConversationContext();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(session['lifecycleManager'].stop).toHaveBeenCalledTimes(1);
  });

  it('preserves NeoKai message history — only touches sdk session fields', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    const db = session.db as unknown as Record<string, ReturnType<typeof mock>>;
    spyOn(session, 'startStreamingQuery').mockResolvedValue(undefined);
    spyOn(session, 'clearModelsCache').mockResolvedValue(undefined);
    spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
    spyOn(session['stateManager'], 'setIdle').mockResolvedValue(undefined);

    await session.clearConversationContext();

    // The only DB mutation is the sdk session-id clear — no message deletion.
    expect(db.updateSession).toHaveBeenCalledTimes(1);
    expect(db.updateSession.mock.calls[0][1]).toEqual({
      sdkSessionId: undefined,
      sdkOriginPath: undefined,
    });
    expect(db.deleteMessagesAfter).not.toHaveBeenCalled();
    expect(db.deleteMessagesAtAndAfter).not.toHaveBeenCalled();
  });

  it('keeps the NeoKai session id stable (no new session, no sdkSessionId retained)', async () => {
    const originalId = 'stable-neokai-session';
    const session = createAgentSession({
      id: originalId,
      sdkSessionId: 'sdk-1',
    } as Partial<Session>);
    spyOn(session, 'startStreamingQuery').mockResolvedValue(undefined);
    spyOn(session, 'clearModelsCache').mockResolvedValue(undefined);
    spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
    spyOn(session['stateManager'], 'setIdle').mockResolvedValue(undefined);

    await session.clearConversationContext();

    // The NeoKai session identity is preserved — only the SDK pointer rotated.
    expect(session.session.id).toBe(originalId);
  });
});
