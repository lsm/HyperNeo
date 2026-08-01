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

  it('bumps the query generation before stop so the old finally is stale (P1-1)', async () => {
    // The runQuery finally (query-runner.ts / acp-query-runner.ts) skips its
    // setIdle() publish when the query generation is stale (the isStaleQuery
    // guard at query-runner.ts:1376 / acp-query-runner.ts:756) — the same
    // mechanism restart relies on. clearConversationContext bumps the generation
    // BEFORE stop() so the old query's finally — which runs as stop() awaits the
    // query promise — observes a stale generation and suppresses the idle. This
    // is timing-robust: a late finally (subprocess exiting after stop()'s
    // termination timeout) still sees the stale generation, unlike a flag that
    // would have reset.
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    spyOn(session, 'startStreamingQuery').mockResolvedValue(undefined);
    spyOn(session, 'clearModelsCache').mockResolvedValue(undefined);
    const genBefore = session.getQueryGeneration();
    let genWhileStopping = genBefore;
    spyOn(session['lifecycleManager'], 'stop').mockImplementation(async () => {
      // The old query's finally runs while stop() awaits queryPromise; the
      // generation it observes must already exceed the old query's generation.
      genWhileStopping = session.getQueryGeneration();
    });

    await session.clearConversationContext();

    // Generation bumped before stop() ran → the old query (genBefore) is stale
    // relative to the generation its finally observes, so the existing
    // isStaleQuery guard skips the setIdle publish. (startStreamingQuery is
    // mocked here; the real start() bumps again for the fresh query.)
    expect(genWhileStopping).toBeGreaterThan(genBefore);
  });

  it('clears ACP session state for ACP-provider slots (P2-3)', async () => {
    const session = createAgentSession({
      sdkSessionId: undefined,
      acpSessionId: 'acp-1',
      config: { provider: 'acp', model: 'codex', maxTokens: 8192, temperature: 1 },
      metadata: { acpInstructionsSent: true, acpContextUsageEstimate: 12345 },
    } as Partial<Session>);
    stubClearExternals(session);
    const db = session.db as unknown as Record<string, ReturnType<typeof mock>>;

    await session.clearConversationContext();

    expect(session.session.acpSessionId).toBeUndefined();
    expect(session.session.metadata?.acpInstructionsSent).toBeUndefined();
    // The fallback usage estimate is cleared too, so the fresh ACP conversation
    // doesn't inherit the prior turn's token total.
    expect(session.session.metadata?.acpContextUsageEstimate).toBeUndefined();
    // The persisted update carries the ACP clear.
    const update = db.updateSession.mock.calls[db.updateSession.mock.calls.length - 1][1] as Record<
      string,
      unknown
    >;
    expect(update.acpSessionId).toBeUndefined();
    expect(
      (update.metadata as { acpInstructionsSent?: unknown })?.acpInstructionsSent
    ).toBeUndefined();
    expect(
      (update.metadata as { acpContextUsageEstimate?: unknown })?.acpContextUsageEstimate
    ).toBeUndefined();
  });

  it('rolls the prior turn cost into costBaseline before restarting (P2 cost)', async () => {
    const session = createAgentSession({
      sdkSessionId: 'sdk-1',
      metadata: { lastSdkCost: 0.42, costBaseline: 1.0 },
    } as Partial<Session>);
    stubClearExternals(session);

    await session.clearConversationContext();

    expect(session.session.metadata?.costBaseline).toBeCloseTo(1.42, 5);
    expect(session.session.metadata?.lastSdkCost).toBe(0);
  });

  it('restores provider env after the clear so it does not leak into the next query', async () => {
    // The generation bump makes the old finally skip its originalEnvVars
    // restore (it only runs for non-stale queries). clearConversationContext
    // must restore the daemon env itself, or the cleared provider's env leaks
    // into the next query's originalEnvVars snapshot.
    const { getProviderService } = await import('../../../../src/lib/provider-service.ts');
    const restoreSpy = spyOn(getProviderService(), 'restoreEnvVars').mockImplementation(() => {});
    const session = createAgentSession({ sdkSessionId: 'sdk-1' } as Partial<Session>);
    (session as unknown as { originalEnvVars: { ANTHROPIC_BASE_URL?: string } }).originalEnvVars = {
      ANTHROPIC_BASE_URL: 'https://daemon.original/v1',
    };
    stubClearExternals(session);

    await session.clearConversationContext();

    expect(restoreSpy).toHaveBeenCalledWith({ ANTHROPIC_BASE_URL: 'https://daemon.original/v1' });
    expect(
      (session as unknown as { originalEnvVars: Record<string, unknown> }).originalEnvVars
    ).toEqual({});
    restoreSpy.mockRestore();
  });
});
