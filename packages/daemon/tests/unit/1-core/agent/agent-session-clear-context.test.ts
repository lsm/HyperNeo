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
 *  - P1-1 regression: no client-visible idle is published mid-clear, so the
 *    one-shot node-agent completion callback (re-registered on session reuse)
 *    is not prematurely fired before the agent processes the handoff.
 */
import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { Database } from '../../../../src/storage/database.ts';
import type { MessageHub, Session } from '@hyperneo/shared';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';

function makeEventBus(): InternalEventBus<DaemonInternalEventMap> {
  return {
    publish: mock(async () => {}),
    publishAsync: mock(() => {}),
    subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

function createAgentSession(
  overrides: Partial<Session> = {},
  eventBus: InternalEventBus<DaemonInternalEventMap> = makeEventBus()
): AgentSession {
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
    eventBus,
    mock(async () => 'test-api-key')
  );
}

/** Stub the spawn/model-fetch/stop side of the clear so it runs in isolation. */
function stubClearExternals(session: AgentSession): void {
  spyOn(session, 'startStreamingQuery').mockResolvedValue(undefined);
  spyOn(session, 'clearModelsCache').mockResolvedValue(undefined);
  spyOn(session['lifecycleManager'], 'stop').mockResolvedValue(undefined);
}

describe('AgentSession.clearConversationContext', () => {
  it('wipes the SDK session pointer in memory and persists it', async () => {
    const session = createAgentSession({
      sdkSessionId: 'sdk-1',
      sdkOriginPath: '/p',
    } as Partial<Session>);
    stubClearExternals(session);
    const db = session.db as unknown as { updateSession: ReturnType<typeof mock> };

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

    await session.clearConversationContext();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(session['lifecycleManager'].stop).toHaveBeenCalledTimes(1);
  });

  it('preserves NeoKai message history — only touches sdk session fields', async () => {
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    stubClearExternals(session);
    const db = session.db as unknown as Record<string, ReturnType<typeof mock>>;

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

  it('keeps the NeoKai session id stable (no new session)', async () => {
    const originalId = 'stable-neokai-session';
    const session = createAgentSession({
      id: originalId,
      sdkSessionId: 'sdk-1',
    } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext();

    // The NeoKai session identity is preserved — only the SDK pointer rotated.
    expect(session.session.id).toBe(originalId);
  });

  it('does NOT publish a client-visible idle mid-clear (P1-1: no spurious completion)', async () => {
    // The node-agent completion detector fires on the first session.updated
    // with processingState.status === 'idle' and sdkCount > 0. On cycle 2+
    // session reuse the detector subscription is freshly active when the clear
    // runs, so an idle published here would prematurely mark the execution
    // complete before the agent processes the handoff. The clear must be
    // invisible to completion detection.
    const eventBus = makeEventBus();
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>, eventBus);
    stubClearExternals(session);
    const publish = eventBus.publish as unknown as ReturnType<typeof mock>;

    await session.clearConversationContext();

    const idlePublishes = publish.mock.calls.filter(
      (call) =>
        call[0] === 'session.updated' &&
        (call[1] as { processingState?: { status?: string } }).processingState?.status === 'idle'
    );
    expect(idlePublishes).toHaveLength(0);
  });
});
